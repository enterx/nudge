#!/usr/bin/env node
/**
 * nudge-hook.mjs — PermissionRequest hook for Claude Code (Node.js)
 *
 * Sends approval requests to mobile via Nudge,
 * waits for response via SSE. On any failure: exits 0 so
 * Claude Code falls back to terminal prompt.
 *
 * Dependencies: None (Node.js built-ins only)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';


import { PROVIDER, SERVER_VERSION, SESSION_ID_PATH, SESSION_NAME_PATH, getSessionId } from './lib/constants.mjs';
import { readConfig, getApiUrl, getOrCreateInstallId } from './lib/config.mjs';
import { getValidToken, refreshToken } from './lib/token-utils.mjs';
import { apiPost } from './lib/api.mjs';
import { waitForDecision } from './lib/sse.mjs';
import { extractSessionName } from './lib/transcript.mjs';
import {
  writePending,
  clearPending,
  cancelOrphansForSession,
  postCancel,
} from './lib/pending-files.mjs';
import { buildEventPayload } from './lib/hook-runtime.mjs';
import { collectAvailableSkills } from './lib/skills.mjs';

// --- Description builders ---

function buildDescription(toolName, toolInput) {
  if (toolInput.command) {
    return `${toolName}: ${toolInput.command}`;
  }
  if (toolInput.file_path || toolInput.notebook_path) {
    return `${toolName}: ${toolInput.file_path || toolInput.notebook_path}`;
  }
  if (toolInput.pattern) {
    const path = toolInput.path ? ` in ${toolInput.path}` : '';
    return `${toolName}: ${toolInput.pattern}${path}`;
  }
  if (toolInput.query) {
    return `${toolName}: ${toolInput.query}`;
  }
  if (toolInput.url) {
    return `${toolName}: ${toolInput.url}`;
  }
  if (toolInput.description) {
    return `${toolName}: ${toolInput.description}`;
  }
  // Generic fallback: show first meaningful string value from toolInput
  for (const val of Object.values(toolInput)) {
    if (typeof val === 'string' && val.length > 0) {
      return `${toolName}: ${val.length > 120 ? val.slice(0, 120) + '...' : val}`;
    }
  }
  return toolName;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

// Redact common credential patterns from a string value.
function sanitizeSecrets(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(/(Basic\s+)[A-Za-z0-9+/]+=*/gi, '$1[REDACTED]')
    .replace(/(--[\w-]*(password|passwd|secret|token|key|credential|auth|apikey|api_key)[=\s]+)\S+/gi, '$1[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]')
    .replace(/(ghp_|ghs_|sk-|eyJ)[A-Za-z0-9_\-.]{10,}/g, '[TOKEN_REDACTED]');
}

function buildToolInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return {};

  const result = { ...rawInput };

  if (typeof result.command === 'string') {
    result.command = sanitizeSecrets(result.command);
  }

  for (const key of ['content', 'new_source', 'old_string', 'new_string']) {
    if (typeof result[key] === 'string' && result[key].length > 2000) {
      result[key] = truncate(result[key], 2000);
    }
  }

  return result;
}

// --- Safe output + exit ---

function exitWithOutput(output) {
  const json = JSON.stringify(output);
  process.stdout.write(json + '\n', () => {
    process.exit(0);
  });
  // Safety net: if callback never fires, force exit after 3s
  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
}

// --- Skip detection ---

function shouldSkip(toolName, toolInput) {
  if (toolName?.includes('nudge')) return true;
  const command = toolInput?.command || '';
  return /\bnudge-\w+\.(sh|mjs)\b/.test(command) || /\/nudge:/.test(command);
}

// --- Main ---

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf-8').trim();

  if (!input) {
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const sessionId = getSessionId(hookData.session_id);

  // Persist session_id to PPID-keyed file so MCP server can read the same ID.
  // Both hooks and MCP server share the same parent (Claude Code process),
  // so process.ppid is the unique key.
  try { writeFileSync(SESSION_ID_PATH, sessionId); } catch { /* ignore */ }
  const cwd = hookData.cwd;
  const transcriptPath = hookData.transcript_path;

  if (!toolName) {
    process.exit(0);
  }

  // Detect AskUserQuestion — now handled via PermissionRequest (same as tool approvals)
  // so both terminal UI and mobile approval run in parallel.
  const isAskUser = toolName === 'AskUserQuestion';
  const hookEventName = 'PermissionRequest';

  // Explicitly allow nudge's own commands
  if (shouldSkip(toolName, toolInput)) {
    return exitWithOutput({
      hookSpecificOutput: { hookEventName, decision: { behavior: 'allow' } },
    });
  }

  const config = readConfig();
  if (!config) {
    process.stderr.write('Nudge: no config found — skipping hook, falling back to built-in prompt\n');
    process.exit(0);
  }

  // Terminal mode — skip Nudge, fall back to built-in approval prompt
  if (config.askMode === 'terminal') {
    process.stderr.write('Nudge: askMode is "terminal" — skipping hook, falling back to built-in prompt\n');
    process.exit(0);
  }

  const token = await getValidToken(config);
  if (!token) {
    process.stderr.write('Nudge: no valid token — skipping hook, falling back to built-in prompt\n');
    process.exit(0);
  }

  const apiUrl = getApiUrl(config);

  // Stable per-computer handle (ADR-003 / M4). Tags the event so the backend
  // refreshes this computer's lastSeenAt and can reject a revoked computer.
  let installId = null;
  try { installId = getOrCreateInstallId(); } catch { /* non-fatal */ }

  // --- Clean up ALL orphaned pending events ---
  // Remaining pending files are from Escape or Terminal No (both use SIGKILL,
  // hook couldn't clean up). Claude Code does NOT fire PostToolUseFailure for
  // rejected tools, so orphan cleanup is the only resolution path.
  // All orphans are marked as 'cancelled'.
  cancelOrphansForSession(sessionId);

  // Build event payload
  const description = buildDescription(toolName, toolInput);
  const sanitizedInput = buildToolInput(toolInput);
  // Session name priority: hook field (if Claude Code exposes it) > transcript /rename > CWD
  const sessionName = hookData.session_name
    || extractSessionName(transcriptPath)
    || (cwd ? cwd.split('/').filter(Boolean).pop() : null);
  // Persist session name so MCP server can read it (same PPID-keyed approach as session ID)
  if (sessionName) {
    try { writeFileSync(SESSION_NAME_PATH, sessionName); } catch { /* ignore */ }
  }

  // --- AskUserQuestion: send as elicitation, return answer via additionalContext ---
  let askUserQuestion = null;
  let askUserOptions = null;
  let askUserMultiSelect = false;

  if (isAskUser && Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
    const q = toolInput.questions[0];
    askUserQuestion = q.question || '';
    askUserMultiSelect = !!q.multiSelect;
    askUserOptions = (q.options || []).map((opt) => ({
      value: opt.value || opt.label,
      label: opt.label,
      ...(opt.description && { description: opt.description }),
    }));
  }

  // Skill Hand: both hook patterns offer skills — elicitation answers and
  // approval responses compose a mounted '/skill args' on the mobile side.
  const availableSkills = collectAvailableSkills({ cwd: cwd || process.cwd() });

  const sensitiveFields = {
    toolInput: isAskUser ? {} : sanitizedInput,
    description: isAskUser ? askUserQuestion || description : description,
    ...(cwd && { cwd }),
    ...(availableSkills.length > 0 && { availableSkills }),
  };

  const payload = buildEventPayload({
    base: {
      provider: PROVIDER,
      pluginVersion: SERVER_VERSION,
      toolName,
      pattern: isAskUser ? 'elicitation' : 'approval',
      sessionId,
      ...(installId && { installId }),
      ...(sessionName && { sessionName }),
      ...(isAskUser && askUserOptions && { options: askUserOptions }),
      ...(isAskUser && { multiSelect: askUserMultiSelect }),
    },
    sensitive: sensitiveFields,
    config,
    fallbackDescription: isAskUser ? 'Question for you' : `${toolName} requires approval`,
  });

  // POST event
  let createResp;
  try {
    createResp = await apiPost(apiUrl, 'eventsCreate', payload, token);
  } catch (err) {
    if (err.status === 402) {
      const code = err.body?.code;
      if (code === 'FREE_LIMIT_REACHED') {
        const limit = err.body?.limit ?? 30;
        process.stderr.write(
          `Nudge: Daily free limit reached (${limit} events/day). ` +
          'Upgrade to Pro in the Nudge app for unlimited access. ' +
          'Falling back to terminal prompt.\n',
        );
      } else {
        process.stderr.write(
          'Nudge: Subscription required. ' +
          'Open the Nudge app to upgrade. Falling back to terminal prompt.\n',
        );
      }
      process.exit(0);
    }
    if (err.status === 403 && err.body?.code === 'COMPUTER_REVOKED') {
      // This computer was removed from the paired list in the mobile app.
      // Stop sending events to the phone and fall back to the terminal prompt;
      // re-pair to use Nudge from this machine again.
      process.stderr.write(
        'Nudge: This computer was unpaired from the Nudge app. ' +
        'Run /pair to reconnect. Falling back to terminal prompt.\n',
      );
      process.exit(0);
    }
    throw err; // re-throw other errors → caught by outer catch → exit(0)
  }

  const eventId = createResp.eventId;
  const rtdbStreamUrl = createResp.rtdbStreamUrl;
  if (!eventId || !rtdbStreamUrl) {
    process.exit(0);
  }

  if (createResp.deviceCount === 0) {
    process.stderr.write(
      'Nudge: No devices registered for push notifications. ' +
      'Open the Nudge app on your phone and enable notifications.\n',
    );
    process.exit(0);
  }

  // Track this event so PostToolUse can cancel it if the user bypassed via terminal.
  writePending(sessionId, eventId, {
    apiUrl,
    token,
    pattern: isAskUser ? 'elicitation' : 'approval',
    toolUseId: hookData.tool_use_id,
    toolName,
    toolInput,
  });

  process.stderr.write(
    isAskUser
      ? `Nudge: Question sent to your phone. Press Escape to answer here instead.\n`
      : `Nudge: Waiting for approval on your phone... (event: ${eventId})\n`,
  );

  // Cancel event on the backend when the hook is interrupted (Escape / SIGINT).
  let cancelRequested = false;

  const cancelAndExit = (signal) => {
    if (cancelRequested) return;
    cancelRequested = true;
    clearPending(sessionId, eventId);
    postCancel({ apiUrl, eventId, token, reason: 'Escaped in terminal' })
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => cancelAndExit(sig));
  }
  // stdin-close/end: terminal answered or another PermissionRequest took over.
  // Do NOT cancel the backend event — only SIGINT/SIGTERM/SIGHUP mean user-initiated cancel.
  // Leave the pending file intact so PostToolUse can resolve the event with the
  // actual tool_response data (e.g., AskUserQuestion answers).
  //
  // Write a stdin-close marker file so PostToolUseFailure can distinguish
  // Terminal No (stdin close → marker exists → 'denied') from
  // Escape (SIGKILL → no marker → 'cancelled').
  // stdin-close/end: terminal answered (Yes or No).
  // Claude Code sends SIGKILL for both Terminal No and Escape, so these
  // handlers rarely fire. When they do, just exit cleanly.
  // The pending file is left intact for PostToolUse/PostToolUseFailure to resolve.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.on('disconnect', () => cancelAndExit('disconnect'));

  // Ensure stdin is resumed so 'close'/'end' events can fire.
  process.stdin.resume();

  // Wait for decision via RTDB SSE streaming
  let decision;
  try {
    decision = await waitForDecision(rtdbStreamUrl, token, {
      // Permission prompts can sit unanswered past the 1h Firebase token
      // lifetime — refresh on SSE auth failures instead of replaying the
      // expired token until the retry budget is gone.
      getFreshToken: () => refreshToken(readConfig()),
    });
  } catch {
    cancelAndExit('sse-error');
    return;
  }
  const action = decision.action;

  // Mobile responded — clear pending file
  clearPending(sessionId, eventId);

  if (action === 'approved' || action === 'approved_always') {
    // "approved_always" is only valid for PermissionRequest (tool approvals).
    // AskUserQuestion should never get "always allow" rules.
    const isAlways = action === 'approved_always' && !isAskUser;
    process.stderr.write(
      isAlways ? 'Nudge: Approved (always allow)\n' : 'Nudge: Approved\n',
    );

    // For "always allow", add a permission rule to Claude Code settings
    if (isAlways) {
      try {
        const settingsPath = join(cwd || process.cwd(), '.claude', 'settings.local.json');
        let settings;
        try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8').replace(/^\s*\/\/.*$/gm, '')); }
        catch { settings = {}; }

        settings.permissions ??= {};
        settings.permissions.allow ??= [];

        const rule = toolName === 'Bash' && toolInput?.command
          ? `Bash(${toolInput.command.trim().split(/\s+/)[0]}:*)`
          : toolName;

        if (!settings.permissions.allow.includes(rule)) {
          settings.permissions.allow.push(rule);
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
          process.stderr.write(`Nudge: Added "${rule}" to .claude/settings.local.json\n`);
        }
      } catch {
        process.stderr.write('Nudge: Could not save "always allow" rule to settings.\n');
      }
    }

    return exitWithOutput({
      hookSpecificOutput: { hookEventName, decision: { behavior: 'allow' } },
    });
  } else if (action === 'answered' && isAskUser) {
    // AskUserQuestion: user answered on mobile — use updatedInput to inject
    // the answer directly, bypassing the terminal prompt cleanly.
    // 'allow' + updatedInput.answers avoids "Denied by PermissionRequest hook".
    const selected = decision.selectedOptions || [];
    const freeText = decision.reason || '';
    const answerLabel = selected.length > 0 ? selected.join(', ') : freeText || 'No answer';
    process.stderr.write(`Nudge: User answered — ${answerLabel}\n`);

    // Build updatedInput with the answer injected into the questions/answers format
    const questionText = askUserQuestion || 'question';
    const answers = { [questionText]: answerLabel };
    const updatedInput = { ...toolInput, answers };

    return exitWithOutput({
      hookSpecificOutput: {
        hookEventName,
        decision: { behavior: 'allow', updatedInput },
      },
    });
  } else if (action === 'denied') {
    const reason = decision.reason || 'No reason given';
    process.stderr.write(`Nudge: Denied — ${reason}\n`);

    return exitWithOutput({
      hookSpecificOutput: {
        hookEventName,
        decision: {
          behavior: 'deny',
          message: isAskUser ? `Declined via Nudge: ${reason}` : `Denied via Nudge: ${reason}`,
        },
        ...(isAskUser && { additionalContext: `User declined to answer: ${reason}` }),
      },
    });
  } else {
    process.exit(0);
  }
}

main().catch(() => {
  // On any error, exit 0 so Claude Code falls back to terminal prompt
  process.exit(0);
});
