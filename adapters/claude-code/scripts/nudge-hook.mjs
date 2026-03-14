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

import { PROVIDER } from './lib/constants.mjs';
import { createLogger } from './lib/logger.mjs';
import { readConfig, getApiUrl } from './lib/config.mjs';
import { getValidToken } from './lib/token-utils.mjs';
import { apiPost } from './lib/api.mjs';
import { waitForDecision } from './lib/sse.mjs';
import { extractSessionName } from './lib/transcript.mjs';

const { log: hookLog } = createLogger('hook-debug');

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
  const sessionId = hookData.session_id || 'unknown';
  const cwd = hookData.cwd;
  const transcriptPath = hookData.transcript_path;

  if (!toolName) {
    process.exit(0);
  }

  // Explicitly allow nudge's own commands
  if (shouldSkip(toolName, toolInput)) {
    return exitWithOutput({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
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

  // Build event payload
  const description = buildDescription(toolName, toolInput);
  const sanitizedInput = buildToolInput(toolInput);
  const sessionName = extractSessionName(transcriptPath);

  const payload = {
    provider: PROVIDER,
    toolName,
    toolInput: sanitizedInput,
    description,
    pattern: 'approval',
    sessionId,
    ...(cwd && { cwd }),
    ...(sessionName && { sessionName }),
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

  process.stderr.write(
    `Nudge: Waiting for approval on your phone... (event: ${eventId})\n`,
  );

  // Cancel event on the backend when the hook is interrupted (Escape / SIGINT).
  // Single boolean guard prevents race conditions from multiple signals.
  let cancelled = false;

  const cancelAndExit = (signal) => {
    if (cancelled) return;
    cancelled = true;
    hookLog(`signal: ${signal}, cancelling eventId=${eventId}`);
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
  process.stdin.on('close', () => cancelAndExit('stdin-close'));

  hookLog(`waiting for decision, eventId=${eventId}`);

  // Wait for decision via RTDB SSE streaming
  let decision;
  try {
    decision = await waitForDecision(rtdbStreamUrl, token);
    cancelled = true; // Prevent cancel on normal completion
  } catch {
    cancelAndExit('sse-error');
    return;
  }
  const action = decision.action;

  if (action === 'approved' || action === 'approved_always') {
    const isAlways = action === 'approved_always';
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
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
  } else if (action === 'denied') {
    const reason = decision.reason || 'No reason given';
    process.stderr.write(`Nudge: Denied — ${reason}\n`);

    return exitWithOutput({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: `Denied via Nudge: ${reason}`,
        },
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
