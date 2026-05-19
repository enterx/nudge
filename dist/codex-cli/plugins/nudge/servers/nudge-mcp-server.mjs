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

import { createInterface } from 'node:readline';

import {
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
} from '../scripts/lib/constants.mjs';
import { createLogger } from '../scripts/lib/logger.mjs';
import {
  runAskUser,
  runApprove,
  runNotify,
  runStatus,
} from '../scripts/lib/handlers.mjs';

const { log: debugLog } = createLogger('mcp-debug');

// --- In-flight request tracking (for MCP `notifications/cancelled`) ---

const inFlightRequests = new Map();

function trackRequest(requestId) {
  if (!requestId) return { register: () => {}, release: () => {} };
  return {
    register: (ctx) => inFlightRequests.set(requestId, ctx),
    release: () => inFlightRequests.delete(requestId),
  };
}

// --- MCP tool handlers (thin wrappers over lib/handlers.mjs) ---

function mcpResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

async function handleNudgeAskUser(args, requestId) {
  const tracker = trackRequest(requestId);
  try {
    const result = await runAskUser(args, {
      onEventCreated: (ctx) => tracker.register(ctx),
    });
    return mcpResult(result);
  } finally {
    tracker.release();
  }
}

async function handleNudgeApprove(args, requestId) {
  const tracker = trackRequest(requestId);
  try {
    const result = await runApprove(args, {
      onEventCreated: (ctx) => tracker.register(ctx),
    });
    return mcpResult(result);
  } finally {
    tracker.release();
  }
}

async function handleNudgeNotify(args) {
  const result = await runNotify(args);
  return mcpResult(result);
}

async function handleNudgeStatus(args) {
  const result = await runStatus(args);
  return mcpResult(result);
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
        inflight.cancel();
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
