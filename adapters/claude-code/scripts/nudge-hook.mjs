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

import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { PROVIDER, SESSION_ID_PATH, getSessionId } from './lib/constants.mjs';
import { createLogger } from './lib/logger.mjs';
import { readConfig, getApiUrl } from './lib/config.mjs';
import { getValidToken } from './lib/token-utils.mjs';
import { apiPost } from './lib/api.mjs';
import { waitForDecision } from './lib/sse.mjs';
import { extractSessionName } from './lib/transcript.mjs';
import { encryptFields } from './lib/crypto.mjs';

const { log: hookLog } = createLogger('hook-debug');

// --- Pending event tracking ---
// Stores the current eventId so PostToolUse can cancel it if the user
// responded via terminal (bypassing the mobile approval).

function pendingFilePath(sessionId, eventId) {
  return join(homedir(), '.nudge', `pending-${sessionId}-${eventId}.json`);
}

function writePending(sessionId, eventId, apiUrl, token, pattern, toolUseId, toolName) {
  try {
    writeFileSync(
      pendingFilePath(sessionId, eventId),
      JSON.stringify({ eventId, apiUrl, token, pattern, toolUseId, toolName }),
      { mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

function clearPending(sessionId, eventId) {
  try { unlinkSync(pendingFilePath(sessionId, eventId)); } catch { /* ignore */ }
}

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

// --- Encryption helper ---

function encryptSensitiveFields(config, fields) {
  const key = config?.encryptionKey;
  if (!key) return null;

  // Full payload for RTDB (includes toolInput — can be large)
  const full = encryptFields(key, {
    toolInput: fields.toolInput,
    description: fields.description,
    ...(fields.context && { context: fields.context }),
    ...(fields.cwd && { cwd: fields.cwd }),
    ...(fields.sessionName && { sessionName: fields.sessionName }),
  });

  // Small notification payload for FCM push (description + sessionName)
  const notif = encryptFields(key, {
    description: fields.description,
    ...(fields.sessionName && { sessionName: fields.sessionName }),
  });

  return {
    encryptedPayload: full.encryptedPayload,
    iv: full.iv,
    encryptedNotif: notif.encryptedPayload,
    notifIv: notif.iv,
  };
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
  // Persist session_id to file so MCP server can read the same ID.
  // Write to both port-specific AND generic file — MCP may not have
  // CLAUDE_CODE_SSE_PORT in its environment, so it reads the generic one.
  try { writeFileSync(SESSION_ID_PATH, sessionId); } catch { /* ignore */ }
  const genericPath = join(homedir(), '.nudge', 'session_id');
  if (SESSION_ID_PATH !== genericPath) {
    try { writeFileSync(genericPath, sessionId); } catch { /* ignore */ }
  }
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
    process.exit(0);
  }

  // Terminal mode — skip Nudge, fall back to built-in approval prompt
  if (config.askMode === 'terminal') {
    process.exit(0);
  }

  const token = await getValidToken(config);
  if (!token) {
    process.exit(0);
  }

  const apiUrl = getApiUrl(config);

  // --- Clean up orphaned elicitation events from previous Escape/SIGKILL ---
  // When AskUserQuestion is Escaped, SIGKILL prevents cleanup. The pending file
  // remains on disk. Cancel these orphaned events now before creating a new one.
  try {
    const nudgeDir = join(homedir(), '.nudge');
    const prefix = `pending-${sessionId}-`;
    const orphaned = readdirSync(nudgeDir).filter(
      (f) => f.startsWith(prefix) && f.endsWith('.json'),
    );
    for (const file of orphaned) {
      const filePath = join(nudgeDir, file);
      try {
        const pending = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (pending.pattern !== 'elicitation') continue;
        // Cancel on server (fire-and-forget)
        hookLog(`cleaning orphaned elicitation event: ${pending.eventId}`);
        unlinkSync(filePath);
        fetch(`${apiUrl}/eventsRespond/${pending.eventId}/respond`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pending.token}`,
          },
          body: JSON.stringify({ action: 'cancelled', reason: 'Cancelled (orphaned)' }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore — best effort */ }

  // Build event payload
  const description = buildDescription(toolName, toolInput);
  const sanitizedInput = buildToolInput(toolInput);
  const sessionName = extractSessionName(transcriptPath);

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

  const sensitiveFields = {
    toolInput: isAskUser ? {} : sanitizedInput,
    description: isAskUser ? askUserQuestion || description : description,
    ...(cwd && { cwd }),
    ...(sessionName && { sessionName }),
  };
  const encrypted = encryptSensitiveFields(config, sensitiveFields);

  const payload = {
    provider: PROVIDER,
    toolName,
    pattern: isAskUser ? 'elicitation' : 'approval',
    sessionId,
    ...(isAskUser && askUserOptions && { options: askUserOptions }),
    ...(isAskUser && { multiSelect: askUserMultiSelect }),
    ...(encrypted
      ? {
          encryptedPayload: encrypted.encryptedPayload,
          iv: encrypted.iv,
          encryptedNotif: encrypted.encryptedNotif,
          notifIv: encrypted.notifIv,
          toolInput: {},
          description: isAskUser ? 'Question for you' : `${toolName} requires approval`,
        }
      : sensitiveFields),
  };

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
    throw err; // re-throw non-402 errors → caught by outer catch → exit(0)
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
  const eventPattern = isAskUser ? 'elicitation' : 'approval';
  writePending(sessionId, eventId, apiUrl, token, eventPattern, hookData.tool_use_id, toolName);

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
    hookLog(`signal: ${signal}, cancelling eventId=${eventId}`);
    clearPending(sessionId, eventId);
    fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: 'cancelled', reason: 'Escaped in terminal' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => cancelAndExit(sig));
  }
  // stdin-close/end: terminal answered or another PermissionRequest took over.
  // Do NOT cancel the backend event — only SIGINT/SIGTERM/SIGHUP mean user-initiated cancel.
  // Leave the pending file intact so PostToolUse can resolve the event with the
  // actual tool_response data (e.g., AskUserQuestion answers).
  process.stdin.on('close', () => {
    hookLog('stdin-close — leaving pending for PostToolUse');
    process.exit(0);
  });
  process.stdin.on('end', () => {
    hookLog('stdin-end — leaving pending for PostToolUse');
    process.exit(0);
  });
  process.on('disconnect', () => cancelAndExit('disconnect'));

  hookLog(`waiting for decision, eventId=${eventId}`);

  // Ensure stdin is resumed so 'close'/'end' events can fire.
  process.stdin.resume();

  // Wait for decision via RTDB SSE streaming
  let decision;
  try {
    decision = await waitForDecision(rtdbStreamUrl, token);
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
    // AskUserQuestion: user answered on mobile — allow the tool use
    // and inject the answer via additionalContext so Claude receives it.
    // Using 'allow' (not 'deny') so Claude Code treats it as a valid response.
    const selected = decision.selectedOptions || [];
    const freeText = decision.reason || '';
    const answerLabel = selected.length > 0 ? selected.join(', ') : freeText || 'No answer';
    const questionText = askUserQuestion || 'question';
    const answerContext = `Answered via Nudge: ${answerLabel}`;
    process.stderr.write(`Nudge: User answered — ${answerLabel}\n`);

    return exitWithOutput({
      hookSpecificOutput: {
        hookEventName,
        decision: { behavior: 'allow' },
        additionalContext: answerContext,
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
