/**
 * handlers.mjs — Shared business logic for Nudge tools.
 *
 * Used by both the MCP server (nudge-mcp-server.mjs) and the CLI
 * (nudge-cli.mjs). Returns plain JS results; callers wrap them
 * (MCP content envelope, human-readable text, JSON stdout, …).
 *
 * Cancellation: each long-running handler accepts an `onEventCreated`
 * callback. It fires once the backend event is created, providing
 * { eventId, apiUrl, token, cancel } so callers can hook abort handlers
 * (MCP `notifications/cancelled`, CLI SIGINT, etc.).
 *
 * Dependencies: Node.js built-ins only.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import {
  PROVIDER,
  LAST_NOTIFY_PATH,
  SESSION_NAME_PATH,
  SERVER_VERSION,
  getSessionId,
} from './constants.mjs';
import { readConfig, getApiUrl, updateConfigKey } from './config.mjs';
import { getValidToken } from './token-utils.mjs';
import { apiPost, apiGet } from './api.mjs';
import { waitForDecision } from './sse.mjs';
import { encryptSensitiveFields as encryptSensitiveFieldsShared } from './hook-runtime.mjs';
import { writePending, clearPending } from './pending-files.mjs';

const MAX_STRING_LENGTH = 4000;

function validateStringLength(value, name) {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    throw new Error(`${name} exceeds maximum length of ${MAX_STRING_LENGTH} characters`);
  }
}

function getSessionIdLazy() {
  return getSessionId();
}

function getSessionNameLazy() {
  try {
    const name = readFileSync(SESSION_NAME_PATH, 'utf8').trim();
    return name || null;
  } catch {
    return null;
  }
}

function persistSessionName(name) {
  if (name) {
    try { writeFileSync(SESSION_NAME_PATH, name); } catch { /* ignore */ }
  }
}

function encryptSensitiveFields(fields) {
  return encryptSensitiveFieldsShared(readConfig(), fields);
}

async function getAuthContext() {
  const config = readConfig();
  if (!config) throw new Error('Nudge not configured. User must pair their device first.');
  const token = await getValidToken(config);
  if (!token) throw new Error('No authentication token. User must re-pair their device.');
  return { config, token, apiUrl: getApiUrl(config) };
}

/**
 * Best-effort cancellation of an in-flight event on the backend.
 */
export async function cancelEventOnBackend(apiUrl, eventId, token, reason = 'Cancelled in terminal') {
  await fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'cancelled', reason }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

function notifyCreated(hooks, ctx) {
  try { hooks?.onEventCreated?.(ctx); } catch { /* ignore */ }
}

/**
 * Shared validator for `-o` / `--action` style choice arrays. Caller passes
 * a human-readable singular noun (`option`, `action`) so the error message
 * stays accurate. Throws on bad shape; returns nothing on success.
 */
function validateChoiceList(list, kind) {
  if (!Array.isArray(list)) {
    throw new Error(`${kind}s must be an array`);
  }
  for (const item of list) {
    if (!item.value || !item.label) {
      throw new Error(`Each ${kind} must have "value" and "label"`);
    }
  }
}

/**
 * Cross-cutting lifecycle for `eventsCreate` → SSE wait paths used by
 * `runAskUser` and `runApprove`. Persists a pending file, hooks up
 * the cancel closure (which also clears the pending file), and ensures
 * the pending file is removed once the decision arrives or the caller
 * aborts. When `ttlMs` is set and the SSE wait surfaces a synthetic
 * timeout decision, also best-effort cancels the mobile event so the
 * pending card doesn't linger after the CLI exits.
 * Returns the raw decision payload from the SSE stream.
 */
async function trackAndAwait({
  sessionId, createResp, apiUrl, token, pattern, toolName,
  toolInput, sessionName, hooks, ttlMs,
}) {
  const eventId = createResp.eventId;

  writePending(sessionId, eventId, {
    apiUrl, token, pattern, toolName, toolInput, sessionName,
  });

  notifyCreated(hooks, {
    eventId,
    apiUrl,
    token,
    cancel: () => {
      clearPending(sessionId, eventId);
      return cancelEventOnBackend(apiUrl, eventId, token);
    },
  });

  try {
    const decision = await waitForDecision(createResp.rtdbStreamUrl, token, { timeoutMs: ttlMs });
    if (decision.action === 'timeout') {
      // Layer 1 cleanup: the backend doesn't (yet) auto-cancel on TTL, so we
      // best-effort tell it now. Idempotent with any future backend-side TTL.
      await cancelEventOnBackend(apiUrl, eventId, token, 'TTL elapsed');
    }
    return decision;
  } finally {
    clearPending(sessionId, eventId);
  }
}

function validateTtl(ttl) {
  if (ttl === undefined || ttl === null) return undefined;
  const n = Number(ttl);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('ttl must be a positive number of seconds');
  }
  return Math.floor(n * 1000);
}

// --- runAskUser ---

export async function runAskUser(args, hooks = {}) {
  const {
    question,
    options = [],
    actions = [],
    multiSelect = false,
    textOnly = false,
    context,
    structured,
    ttl,
    sessionName: argSessionName,
  } = args;
  const ttlMs = validateTtl(ttl);

  const sessionName = argSessionName || getSessionNameLazy();
  if (argSessionName) persistSessionName(argSessionName);

  if (!question || typeof question !== 'string') {
    throw new Error('question is required and must be a string');
  }
  validateStringLength(question, 'question');
  validateStringLength(context, 'context');
  validateStringLength(sessionName, 'sessionName');

  validateChoiceList(options, 'option');
  validateChoiceList(actions, 'action');
  if (!textOnly && options.length === 0 && actions.length === 0) {
    throw new Error('ask requires options, --text, or at least one --action');
  }
  if (options.length > 0 && (options.length < 2 || options.length > 4)) {
    throw new Error('options must be an array of 2-4 items');
  }

  const { token, apiUrl } = await getAuthContext();

  const sensitiveFields = {
    toolInput: { question, options, multiSelect, ...(textOnly && { textOnly }), ...(actions.length > 0 && { actions }) },
    description: question,
    ...(context && { context }),
    ...(structured && { structured }),
  };
  const encrypted = encryptSensitiveFields(sensitiveFields);

  const createResp = await apiPost(
    apiUrl,
    'eventsCreate',
    {
      ...(PROVIDER && { provider: PROVIDER }),
      pluginVersion: SERVER_VERSION,
      toolName: 'nudge_ask_user',
      pattern: 'elicitation',
      sessionId: getSessionIdLazy(),
      ...(sessionName && { sessionName }),
      options,
      multiSelect,
      ...(textOnly && { textOnly: true }),
      ...(actions.length > 0 && { actions }),
      ...(ttl !== undefined && { ttl }),
      ...(encrypted
        ? {
            encryptedPayload: encrypted.encryptedPayload,
            iv: encrypted.iv,
            encryptedNotif: encrypted.encryptedNotif,
            notifIv: encrypted.notifIv,
            toolInput: {},
            description: 'Question for you',
          }
        : sensitiveFields),
    },
    token,
  );

  if (!createResp.eventId) {
    throw new Error('Failed to create elicitation event: no eventId returned');
  }
  if (createResp.deviceCount === 0) {
    throw new Error(
      'No devices registered for push notifications. ' +
      'Open the Nudge app on your phone and ensure notifications are enabled, then try again.',
    );
  }

  // `decision.action` is the overall outcome (approved/denied/answered/cancelled/timeout).
  // `decision.selectedAction` (forward-looking, mobile to implement) carries the
  // user's choice when they tap one of the follow-up `--action` buttons.
  const decision = await trackAndAwait({
    sessionId: getSessionIdLazy(),
    createResp, apiUrl, token,
    pattern: 'elicitation',
    toolName: 'nudge_ask_user',
    toolInput: { question, options, multiSelect },
    sessionName,
    hooks,
    ttlMs,
  });

  return {
    selectedOptions: decision.selectedOptions || [],
    freeText: decision.reason || '',
    ...(decision.action === 'timeout' && { timedOut: true }),
    ...(decision.selectedAction && { selectedAction: decision.selectedAction }),
  };
}

// --- runApprove ---

export async function runApprove(args, hooks = {}) {
  const {
    description,
    toolName = 'nudge_approve',
    context,
    toolInput: argToolInput,
    cwd,
    actions = [],
    structured,
    ttl,
    sessionName: argSessionName,
  } = args;
  const ttlMs = validateTtl(ttl);

  const sessionName = argSessionName || getSessionNameLazy();
  if (argSessionName) persistSessionName(argSessionName);

  if (!description || typeof description !== 'string') {
    throw new Error('description is required and must be a string');
  }
  if (!toolName || typeof toolName !== 'string') {
    throw new Error('toolName is required and must be a string');
  }
  validateStringLength(description, 'description');
  validateStringLength(toolName, 'toolName');
  validateStringLength(context, 'context');
  validateStringLength(sessionName, 'sessionName');

  validateChoiceList(actions, 'action');

  const { token, apiUrl } = await getAuthContext();
  const approvalLabel = toolName === 'nudge_approve' ? 'Approval' : toolName;

  const sensitiveFields = {
    toolInput: {
      ...(argToolInput || { description }),
      ...(actions.length > 0 && { actions }),
    },
    description,
    ...(context && { context }),
    ...(cwd && { cwd }),
    ...(structured && { structured }),
  };
  const encrypted = encryptSensitiveFields(sensitiveFields);

  const createResp = await apiPost(
    apiUrl,
    'eventsCreate',
    {
      ...(PROVIDER && { provider: PROVIDER }),
      pluginVersion: SERVER_VERSION,
      toolName,
      pattern: 'approval',
      sessionId: getSessionIdLazy(),
      ...(sessionName && { sessionName }),
      ...(actions.length > 0 && { actions }),
      ...(ttl !== undefined && { ttl }),
      ...(encrypted
        ? {
            encryptedPayload: encrypted.encryptedPayload,
            iv: encrypted.iv,
            encryptedNotif: encrypted.encryptedNotif,
            notifIv: encrypted.notifIv,
            toolInput: {},
            description: `${approvalLabel} requires approval`,
          }
        : sensitiveFields),
    },
    token,
  );

  if (!createResp.eventId) {
    throw new Error('Failed to create approval event: no eventId returned');
  }
  if (createResp.deviceCount === 0) {
    throw new Error(
      'No devices registered for push notifications. ' +
      'Open the Nudge app on your phone and ensure notifications are enabled, then try again.',
    );
  }

  const decision = await trackAndAwait({
    sessionId: getSessionIdLazy(),
    createResp, apiUrl, token,
    pattern: 'approval',
    toolName,
    toolInput: argToolInput || { description },
    sessionName,
    hooks,
    ttlMs,
  });

  return {
    approved: decision.action === 'approved',
    reason: decision.reason || '',
    ...(decision.action === 'timeout' && { timedOut: true }),
    ...(decision.selectedAction && { selectedAction: decision.selectedAction }),
  };
}

// --- runNotify ---

export async function runNotify(args) {
  const {
    title,
    body,
    level = 'info',
    context,
    structured,
    sessionName: argSessionName,
  } = args;

  const sessionName = argSessionName || getSessionNameLazy();
  if (argSessionName) persistSessionName(argSessionName);

  if (!title || typeof title !== 'string') {
    throw new Error('title is required and must be a string');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('body is required and must be a string');
  }
  validateStringLength(title, 'title');
  validateStringLength(body, 'body');
  validateStringLength(context, 'context');
  validateStringLength(sessionName, 'sessionName');

  const validLevels = ['info', 'success', 'warning', 'error'];
  if (!validLevels.includes(level)) {
    throw new Error(`level must be one of: ${validLevels.join(', ')}`);
  }

  const { token, apiUrl } = await getAuthContext();

  const sensitiveFields = {
    toolInput: {},
    description: body,
    ...(context && { context }),
    ...(structured && { structured }),
  };
  const encrypted = encryptSensitiveFields(sensitiveFields);

  await apiPost(
    apiUrl,
    'pushNotifyFn',
    {
      ...(PROVIDER && { provider: PROVIDER }),
      title,
      level,
      pluginVersion: SERVER_VERSION,
      sessionId: getSessionIdLazy(),
      ...(sessionName && { sessionName }),
      ...(encrypted
        ? {
            encryptedPayload: encrypted.encryptedPayload,
            iv: encrypted.iv,
            encryptedNotif: encrypted.encryptedNotif,
            notifIv: encrypted.notifIv,
            body: 'Decrypting...',
          }
        : {
            body,
            ...(context && { context }),
          }),
    },
    token,
  );

  writeFileSync(LAST_NOTIFY_PATH, String(Date.now()), { mode: 0o600 });

  return { sent: true };
}

// --- runStatus ---

export async function runStatus(args = {}) {
  const config = readConfig();

  if (!config) {
    return {
      paired: false,
      message: 'Not paired. Run `nudge pair` to connect your phone.',
    };
  }

  const newMode = args?.mode;
  if (newMode) {
    if (newMode !== 'nudge' && newMode !== 'terminal') {
      throw new Error('mode must be "nudge" or "terminal"');
    }
    updateConfigKey('askMode', newMode);
    config.askMode = newMode;
  }

  const apiUrl = getApiUrl(config);
  const result = {
    paired: true,
    pluginVersion: SERVER_VERSION,
    userId: config.userId || 'unknown',
    pairingCode: config.pairingCode || 'unknown',
    server: apiUrl,
    askMode: config.askMode || 'nudge',
  };

  if (newMode) {
    result.modeChanged = true;
    result.message = newMode === 'nudge'
      ? 'Questions will now be sent to your mobile device.'
      : 'Questions will now appear in the terminal.';
  }

  try {
    const health = await apiGet(apiUrl, 'status');
    result.serverStatus = health.status === 'ok' ? 'Connected' : `Error (${health.status})`;
    if (health.version) {
      result.backendVersion = health.version;
    }
  } catch {
    result.serverStatus = 'Unreachable';
  }

  if (!config.token) {
    result.authStatus = 'No token';
  } else {
    try {
      const validToken = await getValidToken(config);
      result.authStatus = validToken ? 'Valid' : 'Token may be expired';
    } catch {
      result.authStatus = 'Token may be expired';
    }
  }

  return result;
}
