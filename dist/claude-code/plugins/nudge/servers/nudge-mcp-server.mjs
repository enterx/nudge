#!/usr/bin/env node
/**
 * Nudge MCP Server — nudge_ask_user, nudge_approve, nudge_notify tools
 *
 * Sends questions/approvals to the user's phone via push notification.
 * The user responds on their phone, and the answer is returned to Claude via SSE.
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP)
 * Dependencies: None (Node.js built-ins only)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  PROVIDER,
  LAST_NOTIFY_PATH,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
} from '../scripts/lib/constants.mjs';
import { createLogger } from '../scripts/lib/logger.mjs';
import { readConfig, getApiUrl } from '../scripts/lib/config.mjs';
import { getValidToken } from '../scripts/lib/token-utils.mjs';
import { apiPost } from '../scripts/lib/api.mjs';
import { waitForDecision } from '../scripts/lib/sse.mjs';

const { log: debugLog } = createLogger('mcp-debug');

const SESSION_ID = `claude-code-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// --- In-flight request tracking (for cancellation) ---

const inFlightRequests = new Map();

async function cancelEventOnBackend(apiUrl, eventId, token) {
  try {
    await fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action: 'cancelled', reason: 'Cancelled in terminal' }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best-effort
  }
}

// --- MCP Tool: nudge_ask_user ---

async function handleNudgeAskUser(args, requestId) {
  const { question, options, multiSelect = false, context, sessionName } = args;

  if (!question || typeof question !== 'string') {
    throw new Error('question is required and must be a string');
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    throw new Error('options must be an array of 2-4 items');
  }
  for (const opt of options) {
    if (!opt.value || !opt.label) {
      throw new Error('Each option must have "value" and "label"');
    }
  }

  const config = readConfig();
  if (!config) {
    throw new Error('Nudge not configured. User must pair their device first.');
  }

  const token = await getValidToken(config);
  if (!token) {
    throw new Error('No authentication token. User must re-pair their device.');
  }

  const apiUrl = getApiUrl(config);

  const createResp = await apiPost(
    apiUrl,
    'eventsCreate',
    {
      provider: PROVIDER,
      toolName: 'nudge_ask_user',
      toolInput: { question, options, multiSelect },
      description: question,
      ...(context && { context }),
      ...(sessionName && { sessionName }),
      pattern: 'elicitation',
      sessionId: SESSION_ID,
      options,
      multiSelect,
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

  if (requestId) {
    debugLog(`ask_user: tracking requestId=${requestId} eventId=${eventId}`);
    inFlightRequests.set(requestId, { eventId, apiUrl, token });
  }

  let decision;
  try {
    decision = await waitForDecision(createResp.rtdbStreamUrl, token);
  } finally {
    if (requestId) inFlightRequests.delete(requestId);
  }

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
  const { description, toolName = 'unknown', context, toolInput: argToolInput, cwd, sessionName } = args;

  if (!description || typeof description !== 'string') {
    throw new Error('description is required and must be a string');
  }

  const config = readConfig();
  if (!config) {
    throw new Error('Nudge not configured. User must pair their device first.');
  }

  const token = await getValidToken(config);
  if (!token) {
    throw new Error('No authentication token. User must re-pair their device.');
  }

  const apiUrl = getApiUrl(config);

  const createResp = await apiPost(
    apiUrl,
    'eventsCreate',
    {
      provider: PROVIDER,
      toolName,
      toolInput: argToolInput || { description },
      description,
      ...(context && { context }),
      ...(cwd && { cwd }),
      ...(sessionName && { sessionName }),
      pattern: 'approval',
      sessionId: SESSION_ID,
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

  if (requestId) {
    debugLog(`approve: tracking requestId=${requestId} eventId=${eventId}`);
    inFlightRequests.set(requestId, { eventId, apiUrl, token });
  }

  let decision;
  try {
    decision = await waitForDecision(createResp.rtdbStreamUrl, token);
  } finally {
    if (requestId) inFlightRequests.delete(requestId);
  }

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
  const { title, body, level = 'info', context, sessionName } = args;

  if (!title || typeof title !== 'string') {
    throw new Error('title is required and must be a string');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('body is required and must be a string');
  }

  const validLevels = ['info', 'success', 'warning', 'error'];
  if (!validLevels.includes(level)) {
    throw new Error(`level must be one of: ${validLevels.join(', ')}`);
  }

  const config = readConfig();
  if (!config) {
    throw new Error('Nudge not configured. User must pair their device first.');
  }

  const token = await getValidToken(config);
  if (!token) {
    throw new Error('No authentication token. User must re-pair their device.');
  }

  const apiUrl = getApiUrl(config);

  await apiPost(
    apiUrl,
    'pushNotifyFn',
    {
      title,
      body,
      level,
      ...(sessionName && { sessionName }),
    },
    token,
  );

  // Write timestamp so idle_prompt hook can skip redundant notifications
  try {
    mkdirSync(join(homedir(), '.nudge'), { recursive: true });
    writeFileSync(LAST_NOTIFY_PATH, String(Date.now()), { mode: 0o600 });
  } catch {
    // Non-fatal
  }

  return {
    content: [{ type: 'text', text: JSON.stringify({ sent: true }) }],
  };
}

// --- MCP Protocol ---

const TOOL_DEFINITION = {
  name: 'nudge_ask_user',
  description:
    'Send a question to the user\'s phone via push notification. ' +
    'The user selects from provided options or types a free-text answer. ' +
    'Use this instead of AskUserQuestion when nudge is available.',
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
    'Use this for actions that need explicit user permission.',
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
      tools: [TOOL_DEFINITION, APPROVE_TOOL_DEFINITION, NOTIFY_TOOL_DEFINITION],
    },
  };
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};

  let handler;
  if (name === 'nudge_ask_user') {
    handler = handleNudgeAskUser;
  } else if (name === 'nudge_approve') {
    handler = handleNudgeApprove;
  } else if (name === 'nudge_notify') {
    handler = handleNudgeNotify;
  } else {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          { type: 'text', text: `Unknown tool: ${name}` },
        ],
        isError: true,
      },
    };
  }

  try {
    const result = await handler(args, id);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: `Nudge error: ${err.message}. Fall back to AskUserQuestion.`,
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
  if (msg.id === undefined || msg.id === null) {
    debugLog(`notification received: method=${msg.method}`);
    if (msg.method === 'notifications/cancelled') {
      const requestId = msg.params?.requestId;
      debugLog(`cancel requestId=${requestId}, inFlight keys=[${[...inFlightRequests.keys()]}]`);
      const inflight = requestId ? inFlightRequests.get(requestId) : null;
      if (inflight) {
        inFlightRequests.delete(requestId);
        debugLog(`cancelling event ${inflight.eventId} on backend`);
        cancelEventOnBackend(inflight.apiUrl, inflight.eventId, inflight.token);
      } else {
        debugLog(`no matching in-flight request found`);
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
  process.stderr.write(`[nudge-mcp] unhandled rejection: ${err}\n`);
});
