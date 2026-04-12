#!/usr/bin/env node
/**
 * nudge-hook.mjs — PreToolUse hook for Codex CLI (Node.js)
 *
 * Codex CLI does not have a separate PermissionRequest event.
 * This PreToolUse hook classifies tools into "require approval" vs
 * "auto-allow" and sends approval requests to mobile via Nudge
 * for tools that modify the system.
 *
 * Allow: exit 0 with empty stdout (or no JSON)
 * Block: output {"decision":"block","reason":"..."} to stdout
 *
 * On any failure: exits 0 so Codex CLI falls back to its built-in prompt.
 *
 * Dependencies: None (Node.js built-ins only)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { PROVIDER, SERVER_VERSION, SESSION_ID_PATH, SESSION_NAME_PATH, getSessionId } from './lib/constants.mjs';
import { readConfig, getApiUrl } from './lib/config.mjs';
import { getValidToken } from './lib/token-utils.mjs';
import { apiPost } from './lib/api.mjs';
import { waitForDecision } from './lib/sse.mjs';
import { encryptFields } from './lib/crypto.mjs';

// --- Tool classification ---
// Tools that modify the system require mobile approval.
// Read-only tools are auto-allowed.

const WRITE_TOOLS = new Set([
  // Shell execution
  'shell', 'bash', 'Bash',
  // File mutations
  'write_file', 'create_file', 'edit_file', 'apply_patch',
  'replace_in_file', 'delete_file', 'remove_file',
  // Notebook
  'NotebookEdit',
]);

const READ_TOOLS = new Set([
  'read_file', 'cat_file',
  'list_dir', 'ls',
  'search', 'grep', 'find', 'glob', 'Glob', 'Grep',
  'Read', 'WebSearch', 'WebFetch',
]);

function requiresApproval(toolName, config) {
  // Nudge's own tools — always auto-allow
  if (toolName?.includes('nudge')) return false;

  // User-configured always-allow list
  const alwaysAllow = config?.codexAlwaysAllow || [];
  if (alwaysAllow.includes(toolName)) return false;

  // Explicit write tools
  if (WRITE_TOOLS.has(toolName)) return true;

  // Explicit read tools
  if (READ_TOOLS.has(toolName)) return false;

  // Unknown tools: require approval (safe default)
  return true;
}

// --- Pending event tracking ---

function pendingFilePath(sessionId, eventId) {
  return join(homedir(), '.nudge', `pending-${sessionId}-${eventId}.json`);
}

function writePending(sessionId, eventId, apiUrl, token, pattern, toolUseId, toolName, toolInput) {
  const toolInputHash = toolInput
    ? createHash('sha256').update(JSON.stringify(toolInput)).digest('hex').slice(0, 16)
    : '';
  try {
    writeFileSync(
      pendingFilePath(sessionId, eventId),
      JSON.stringify({ eventId, apiUrl, token, pattern, toolUseId, toolName, toolInputHash, createdAt: Date.now() }),
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

// --- Codex output helpers ---

/**
 * Block (deny) a tool use in Codex format.
 * Codex expects: {"decision":"block","reason":"..."}
 */
function exitWithBlock(reason) {
  const json = JSON.stringify({ decision: 'block', reason });
  process.stdout.write(json + '\n', () => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

/**
 * Allow a tool use in Codex format.
 * Empty stdout + exit 0 = allow.
 */
function exitWithAllow() {
  process.exit(0);
}

// --- Encryption helper ---

function encryptSensitiveFields(config, fields) {
  const key = config?.encryptionKey;
  if (!key) return null;

  const full = encryptFields(key, {
    toolInput: fields.toolInput,
    description: fields.description,
    ...(fields.context && { context: fields.context }),
    ...(fields.cwd && { cwd: fields.cwd }),
    ...(fields.sessionName && { sessionName: fields.sessionName }),
  });

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

  // Persist session_id to PPID-keyed file so MCP server can read the same ID.
  try { writeFileSync(SESSION_ID_PATH, sessionId); } catch { /* ignore */ }
  const cwd = hookData.cwd;

  if (!toolName) {
    process.exit(0);
  }

  // Explicitly allow nudge's own commands
  if (shouldSkip(toolName, toolInput)) {
    return exitWithAllow();
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

  // --- Tool classification ---
  // Codex PreToolUse fires for ALL tools. Only intercept tools that
  // require approval (write/execute). Read-only tools are auto-allowed.
  if (!requiresApproval(toolName, config)) {
    return exitWithAllow();
  }

  const token = await getValidToken(config);
  if (!token) {
    process.stderr.write('Nudge: no valid token — skipping hook, falling back to built-in prompt\n');
    process.exit(0);
  }

  const apiUrl = getApiUrl(config);

  // --- Clean up ALL orphaned pending events ---
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
        unlinkSync(filePath);
        fetch(`${apiUrl}/eventsRespond/${pending.eventId}/respond`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${pending.token}`,
          },
          body: JSON.stringify({ action: 'cancelled', reason: 'Cancelled in terminal' }),
          signal: AbortSignal.timeout(5_000),
        }).catch(() => {});
      } catch { /* ignore individual file errors */ }
    }
  } catch { /* ignore — best effort */ }

  // Build event payload
  const description = buildDescription(toolName, toolInput);
  const sanitizedInput = buildToolInput(toolInput);
  // Session name: CWD-based (Codex doesn't have /rename or transcript session names)
  const sessionName = cwd ? cwd.split('/').filter(Boolean).pop() : null;
  if (sessionName) {
    try { writeFileSync(SESSION_NAME_PATH, sessionName); } catch { /* ignore */ }
  }

  const sensitiveFields = {
    toolInput: sanitizedInput,
    description,
    ...(cwd && { cwd }),
  };
  const encrypted = encryptSensitiveFields(config, sensitiveFields);

  const payload = {
    provider: PROVIDER,
    pluginVersion: SERVER_VERSION,
    toolName,
    pattern: 'approval',
    sessionId,
    ...(sessionName && { sessionName }),
    ...(encrypted
      ? {
          encryptedPayload: encrypted.encryptedPayload,
          iv: encrypted.iv,
          encryptedNotif: encrypted.encryptedNotif,
          notifIv: encrypted.notifIv,
          toolInput: {},
          description: `${toolName} requires approval`,
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
    throw err;
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
  writePending(sessionId, eventId, apiUrl, token, 'approval', hookData.tool_use_id, toolName, toolInput);

  process.stderr.write(
    `Nudge: Waiting for approval on your phone... (event: ${eventId})\n`,
  );

  // Cancel event on the backend when the hook is interrupted.
  let cancelRequested = false;

  const cancelAndExit = (signal) => {
    if (cancelRequested) return;
    cancelRequested = true;
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
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.on('disconnect', () => cancelAndExit('disconnect'));

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
    const isAlways = action === 'approved_always';
    process.stderr.write(
      isAlways ? 'Nudge: Approved (always allow)\n' : 'Nudge: Approved\n',
    );

    // For "always allow", save to nudge config (Codex has no settings.local.json)
    if (isAlways) {
      try {
        const configPath = join(homedir(), '.nudge', 'config');
        let cfg;
        try { cfg = JSON.parse(readFileSync(configPath, 'utf-8')); }
        catch { cfg = {}; }

        cfg.codexAlwaysAllow ??= [];

        // For Bash commands, add "Bash:<first-word>:*" pattern
        const rule = toolName === 'Bash' && toolInput?.command
          ? `Bash:${toolInput.command.trim().split(/\s+/)[0]}`
          : toolName;

        if (!cfg.codexAlwaysAllow.includes(rule)) {
          cfg.codexAlwaysAllow.push(rule);
          writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
          process.stderr.write(`Nudge: Added "${rule}" to ~/.nudge/config codexAlwaysAllow\n`);
        }
      } catch {
        process.stderr.write('Nudge: Could not save "always allow" rule.\n');
      }
    }

    // Allow: empty stdout
    return exitWithAllow();
  } else if (action === 'denied') {
    const reason = decision.reason || 'No reason given';
    process.stderr.write(`Nudge: Denied — ${reason}\n`);

    // Block: Codex format
    return exitWithBlock(`Denied via Nudge: ${reason}`);
  } else {
    // Unknown action — allow (fail open)
    process.exit(0);
  }
}

main().catch(() => {
  // On any error, exit 0 so Codex CLI falls back to its built-in prompt
  process.exit(0);
});
