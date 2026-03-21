#!/usr/bin/env node
/**
 * Nudge MCP Server — nudge_ask_user, nudge_approve, nudge_notify,
 *   nudge_status tools
 *
 * Sends questions/approvals to the user's phone via push notification.
 * The user responds on their phone, and the answer is returned to Claude via SSE.
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP)
 * Dependencies: None (Node.js built-ins only)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  PROVIDER,
  LAST_NOTIFY_PATH,
  SESSION_NAME_PATH,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  getSessionId,
} from '../scripts/lib/constants.mjs';
import { createLogger } from '../scripts/lib/logger.mjs';
import { readConfig, getApiUrl, updateConfigKey } from '../scripts/lib/config.mjs';
import { getValidToken } from '../scripts/lib/token-utils.mjs';
import { apiPost, apiGet } from '../scripts/lib/api.mjs';
import { waitForDecision } from '../scripts/lib/sse.mjs';
import { encryptFields } from '../scripts/lib/crypto.mjs';
const { log: debugLog } = createLogger('mcp-debug');

// Read session ID fresh every time — the file is updated by hooks when a new
// session starts, so caching risks returning a stale ID from the prior session.
// readFileSync is ~50μs, negligible compared to MCP tool call latency.
function getSessionIdLazy() {
  return getSessionId();
}

// Read session name written by hooks (from /rename or transcript extraction).
// If not found and a name is provided by Claude, persist it for later calls.
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

// --- Input validation ---

const MAX_STRING_LENGTH = 4000;

function validateStringLength(value, name) {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
    throw new Error(`${name} exceeds maximum length of ${MAX_STRING_LENGTH} characters`);
  }
}

// --- Encryption helpers ---

function getEncryptionKey() {
  const config = readConfig();
  return config?.encryptionKey || null;
}

/**
 * Encrypt sensitive fields if an encryption key is available.
 * Returns the encrypted fields to spread into the API request body,
 * replacing the plaintext versions.
 */
function encryptSensitiveFields(fields) {
  const key = getEncryptionKey();
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
  // Decrypted on-device by iOS NSE / Android background handler
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

// --- Auth helper ---

async function getAuthContext() {
  const config = readConfig();
  if (!config) throw new Error('Nudge not configured. User must pair their device first.');
  const token = await getValidToken(config);
  if (!token) throw new Error('No authentication token. User must re-pair their device.');
  return { config, token, apiUrl: getApiUrl(config) };
}

// --- In-flight request tracking (for cancellation) ---

const inFlightRequests = new Map();

async function cancelEventOnBackend(apiUrl, eventId, token) {
  await fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'cancelled', reason: 'Cancelled in terminal' }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {}); // Best-effort
}

async function waitWithTracking(rtdbStreamUrl, token, apiUrl, eventId, requestId) {
  if (requestId) {
    inFlightRequests.set(requestId, { eventId, apiUrl, token });
  }
  try {
    return await waitForDecision(rtdbStreamUrl, token);
  } finally {
    if (requestId) inFlightRequests.delete(requestId);
  }
}

// --- MCP Tool: nudge_ask_user ---

async function handleNudgeAskUser(args, requestId) {
  const { question, options, multiSelect = false, context, sessionName: argSessionName } = args;
  const sessionName = argSessionName || getSessionNameLazy();
  if (argSessionName) persistSessionName(argSessionName);

  if (!question || typeof question !== 'string') {
    throw new Error('question is required and must be a string');
  }
  validateStringLength(question, 'question');
  validateStringLength(context, 'context');
  validateStringLength(sessionName, 'sessionName');
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    throw new Error('options must be an array of 2-4 items');
  }
  for (const opt of options) {
    if (!opt.value || !opt.label) {
      throw new Error('Each option must have "value" and "label"');
    }
  }

  const { token, apiUrl } = await getAuthContext();

  const sensitiveFields = {
    toolInput: { question, options, multiSelect },
    description: question,
    ...(context && { context }),
  };
  const encrypted = encryptSensitiveFields(sensitiveFields);

  const createResp = await apiPost(
    apiUrl,
    'eventsCreate',
    {
      provider: PROVIDER,
      toolName: 'nudge_ask_user',
      pattern: 'elicitation',
      sessionId: getSessionIdLazy(),
      ...(sessionName && { sessionName }),
      options,
      multiSelect,
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

  const eventId = createResp.eventId;
  if (!eventId) {
    throw new Error('Failed to create elicitation event: no eventId returned');
  }

  if (createResp.deviceCount === 0) {
    throw new Error(
      'No devices registered for push notifications. ' +
      'Open the Nudge app on your phone and ensure notifications are enabled, then try again.',
    );
  }

  const decision = await waitWithTracking(createResp.rtdbStreamUrl, token, apiUrl, eventId, requestId);

  const result = {
    selectedOptions: decision.selectedOptions || [],
    freeText: decision.reason || '',
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

// --- MCP Tool: nudge_approve ---

async function handleNudgeApprove(args, requestId) {
  const { description, toolName = 'unknown', context, toolInput: argToolInput, cwd, sessionName: argSessionName } = args;
  const sessionName = argSessionName || getSessionNameLazy();
  if (argSessionName) persistSessionName(argSessionName);

  if (!description || typeof description !== 'string') {
    throw new Error('description is required and must be a string');
  }
  validateStringLength(description, 'description');
  validateStringLength(context, 'context');
  validateStringLength(sessionName, 'sessionName');

  const { token, apiUrl } = await getAuthContext();

  const sensitiveFields = {
    toolInput: argToolInput || { description },
    description,
    ...(context && { context }),
    ...(cwd && { cwd }),
  };
  const encrypted = encryptSensitiveFields(sensitiveFields);

  const createResp = await apiPost(
    apiUrl,
    'eventsCreate',
    {
      provider: PROVIDER,
      toolName,
      pattern: 'approval',
      sessionId: getSessionIdLazy(),
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
    },
    token,
  );

  const eventId = createResp.eventId;
  if (!eventId) {
    throw new Error('Failed to create approval event: no eventId returned');
  }

  if (createResp.deviceCount === 0) {
    throw new Error(
      'No devices registered for push notifications. ' +
      'Open the Nudge app on your phone and ensure notifications are enabled, then try again.',
    );
  }

  const decision = await waitWithTracking(createResp.rtdbStreamUrl, token, apiUrl, eventId, requestId);

  const approved = decision.action === 'approved';
  const result = {
    approved,
    reason: decision.reason || '',
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

// --- MCP Tool: nudge_notify ---

async function handleNudgeNotify(args) {
  const { title, body, level = 'info', context, sessionName: argSessionName } = args;
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
  };
  const encrypted = encryptSensitiveFields(sensitiveFields);

  await apiPost(
    apiUrl,
    'pushNotifyFn',
    {
      title,
      level,
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

  // Write timestamp so idle_prompt hook can skip redundant notifications
  writeFileSync(LAST_NOTIFY_PATH, String(Date.now()), { mode: 0o600 });

  return {
    content: [{ type: 'text', text: JSON.stringify({ sent: true }) }],
  };
}

// --- MCP Tool: nudge_status ---
// Also handles mode switching when "mode" parameter is provided.

async function handleNudgeStatus(args) {
  const config = readConfig();

  if (!config) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        paired: false,
        message: 'Not paired. Run /pair-nudge to connect your phone.',
      }) }],
    };
  }

  // Handle mode switching if requested
  const newMode = args?.mode;
  if (newMode) {
    if (newMode !== 'nudge' && newMode !== 'terminal') {
      throw new Error('mode must be "nudge" or "terminal"');
    }
    const previousMode = config.askMode || 'nudge';
    updateConfigKey('askMode', newMode);
    config.askMode = newMode;
  }

  const apiUrl = getApiUrl(config);
  const result = {
    paired: true,
    userId: config.userId || 'unknown',
    pairingCode: config.pairingCode || 'unknown',
    server: apiUrl,
    askMode: config.askMode || 'nudge',
  };

  // Include mode change info if switched
  if (newMode) {
    result.modeChanged = true;
    result.message = newMode === 'nudge'
      ? 'Questions will now be sent to your mobile device.'
      : 'Questions will now appear in the terminal.';
  }

  // Check server connectivity
  try {
    const health = await apiGet(apiUrl, 'status');
    result.serverStatus = health.status === 'ok' ? 'Connected' : `Error (${health.status})`;
  } catch {
    result.serverStatus = 'Unreachable';
  }

  // Check token validity
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

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

// --- MCP Protocol ---

const TOOL_DEFINITION = {
  name: 'nudge_ask_user',
  description:
    'Send a question to the user\'s phone via push notification. ' +
    'The user selects from provided options or types a free-text answer. ' +
    'Recommended for questions in nudge mode. MCP tools have reliable event lifecycle — ' +
    'no consistency issues with hook-based AskUserQuestion cancellation (SIGKILL).',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to ask the user',
      },
      options: {
        type: 'array',
        description: 'Available choices (2-4 items)',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'Machine-readable value' },
            label: { type: 'string', description: 'Human-readable label' },
            description: {
              type: 'string',
              description: 'Optional explanation of this option',
            },
          },
          required: ['value', 'label'],
        },
        minItems: 2,
        maxItems: 4,
      },
      multiSelect: {
        type: 'boolean',
        description:
          'If true, user can select multiple options. Default: false',
        default: false,
      },
      context: {
        type: 'string',
        description:
          'Brief summary of what you are doing and why you need to ask this question. ' +
          'Shown on the mobile app to help the user understand the situation.',
      },
      sessionName: {
        type: 'string',
        description:
          'The current coding session or project name (e.g. from /rename). ' +
          'Shown as the session title on the mobile app.',
      },
    },
    required: ['question', 'options'],
  },
};

const APPROVE_TOOL_DEFINITION = {
  name: 'nudge_approve',
  description:
    'Send an approval request to the user\'s phone via push notification. ' +
    'The user taps Approve or Deny. Returns { approved: boolean, reason: string }. ' +
    'Use this for yes/no decisions that are NOT tool-call approvals — e.g., ' +
    '"Deploy to prod?", "Create PR?", "Proceed with this approach?". ' +
    'Tool-call approvals (Bash, Write, Edit) are handled automatically by hooks.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'What action needs approval (shown to the user)',
      },
      toolName: {
        type: 'string',
        description: 'Name of the tool/action requesting approval',
      },
      context: {
        type: 'string',
        description:
          'Brief summary of what you are doing and why this action is needed. ' +
          'Shown on the mobile app to help the user make an informed decision.',
      },
      toolInput: {
        type: 'object',
        description:
          'The original tool input (command, file_path, code, etc.) for rich display on mobile.',
      },
      cwd: {
        type: 'string',
        description: 'Current working directory where the action will run.',
      },
      sessionName: {
        type: 'string',
        description:
          'The current coding session or project name (e.g. from /rename). ' +
          'Shown as the session title on the mobile app.',
      },
    },
    required: ['description'],
  },
};

const NOTIFY_TOOL_DEFINITION = {
  name: 'nudge_notify',
  description:
    'Send a one-way notification to the user\'s phone (fire-and-forget). ' +
    'Use for status updates, build results, error alerts, or progress milestones. ' +
    'Does NOT wait for a response — returns immediately. ' +
    'IMPORTANT: Always send a "success" notification when you finish a task, ' +
    'with a brief summary of what was accomplished in the body and ' +
    'conversation context in the context field.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Notification title, e.g. "Build Complete"',
      },
      body: {
        type: 'string',
        description:
          'Notification body with details. For task completion, include a ' +
          'concise summary of what was done (e.g. "Fixed QR retry bug in ' +
          'qr-scanner.tsx — scanned flag now resets on failure").',
      },
      level: {
        type: 'string',
        enum: ['info', 'success', 'warning', 'error'],
        description:
          'Notification level: "info" (default), "success" for completions, ' +
          '"warning" for attention needed, "error" for failures',
        default: 'info',
      },
      context: {
        type: 'string',
        description:
          'Summary of the conversation so far — what was discussed, decided, ' +
          'and accomplished. Shown on the mobile app so the user can understand ' +
          'the full picture without returning to the terminal.',
      },
      sessionName: {
        type: 'string',
        description:
          'The current coding session or project name. ' +
          'Shown as the session title on the mobile app.',
      },
    },
    required: ['title', 'body'],
  },
};

const STATUS_TOOL_DEFINITION = {
  name: 'nudge_status',
  description:
    'Check Nudge connection and configuration status. ' +
    'Returns pairing state, server connectivity, auth token validity, and current ask mode. ' +
    'Optionally switches the ask mode when "mode" parameter is provided.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['nudge', 'terminal'],
        description:
          'Switch ask mode. "nudge" sends questions to mobile (AFK), ' +
          '"terminal" keeps questions in the terminal (desk). Omit to just check status.',
      },
    },
  },
};

function handleInitialize(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    },
  };
}

function handleToolsList(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      tools: [
        TOOL_DEFINITION, APPROVE_TOOL_DEFINITION, NOTIFY_TOOL_DEFINITION,
        STATUS_TOOL_DEFINITION,
      ],
    },
  };
}

const TOOL_HANDLERS = {
  nudge_ask_user: handleNudgeAskUser,
  nudge_approve: handleNudgeApprove,
  nudge_notify: handleNudgeNotify,
  nudge_status: handleNudgeStatus,
};

async function handleToolsCall(id, params) {
  const name = params?.name;
  const handler = TOOL_HANDLERS[name];

  if (!handler) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      },
    };
  }

  try {
    const result = await handler(params?.arguments || {}, id);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    let message = `Nudge error: ${err.message}. Fall back to AskUserQuestion.`;

    if (err.status === 402) {
      const code = err.body?.code;
      if (code === 'FREE_LIMIT_REACHED') {
        const limit = err.body?.limit ?? 30;
        message =
          `Nudge: Daily free limit reached (${limit} events/day). ` +
          'The user can upgrade to Pro in the Nudge app for unlimited access. ' +
          'Fall back to AskUserQuestion for this interaction.';
      } else {
        message =
          'Nudge: Subscription required. The user can upgrade in the Nudge app. ' +
          'Fall back to AskUserQuestion for this interaction.';
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        isError: true,
      },
    };
  }
}

// --- Main: JSON-RPC over stdio ---

async function handleMessage(msg) {
  debugLog(`incoming: ${JSON.stringify(msg)}`);

  // Handle notifications (no id) — specifically cancellation
  if (msg.id == null) {
    if (msg.method === 'notifications/cancelled') {
      const inflight = msg.params?.requestId && inFlightRequests.get(msg.params.requestId);
      if (inflight) {
        inFlightRequests.delete(msg.params.requestId);
        cancelEventOnBackend(inflight.apiUrl, inflight.eventId, inflight.token);
      }
    }
    return null;
  }

  switch (msg.method) {
    case 'initialize':
      return handleInitialize(msg.id);
    case 'tools/list':
      return handleToolsList(msg.id);
    case 'tools/call':
      return handleToolsCall(msg.id, msg.params);
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    default:
      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

function sendResponse(response) {
  if (!response) return;
  const json = JSON.stringify(response);
  process.stdout.write(json + '\n');
}

debugLog('=== MCP server started ===');

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    sendResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }

  const response = await handleMessage(msg);
  sendResponse(response);
});

rl.on('close', () => {
  process.exit(0);
});

// Prevent unhandled rejection from crashing the server
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : 'unknown error';
  // Redact tokens/credentials that may appear in error messages
  const safe = msg
    .replace(/auth=[^&\s]+/gi, 'auth=[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(/(eyJ)[A-Za-z0-9_\-.]{10,}/g, '[TOKEN_REDACTED]');
  process.stderr.write(`[nudge-mcp] unhandled rejection: ${safe}\n`);
});
