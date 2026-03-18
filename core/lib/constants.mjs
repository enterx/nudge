/**
 * constants.mjs — Shared constants for Nudge plugin
 *
 * Single source of truth for URLs, timeouts, and protocol values.
 * Dependencies: None
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// --- Directories & paths ---

export const NUDGE_CONFIG_DIR =
  process.env.NUDGE_CONFIG_DIR || join(homedir(), '.nudge');

export const CONFIG_PATH =
  process.env.NUDGE_CONFIG_PATH || join(NUDGE_CONFIG_DIR, 'config');

export const LAST_NOTIFY_PATH = join(NUDGE_CONFIG_DIR, 'last_notify');

// --- API ---

export const DEFAULT_API_URL =
  process.env.NUDGE_API_URL ||
  'https://api.appnudge.dev';

export const API_TIMEOUT_MS = 30_000;
export const REFRESH_TOKEN_TIMEOUT_MS = 10_000;

// --- SSE ---

export const SSE_MAX_TIME_MS = 520_000;
export const SSE_MAX_RECONNECTS = 5;

// --- Auth ---

export const TOKEN_REFRESH_BUFFER_SECONDS = 300;

// --- Identity ---

export const PROVIDER = process.env.NUDGE_PROVIDER || 'claude-code';

// --- Session ---

/**
 * Derive a deterministic session ID from the host tool's environment.
 * Both hooks and MCP server call this, so they always produce the same ID
 * for the same Claude Code (or other tool) session.
 *
 * @param {string} [hookSessionId] - session_id from hook input (ignored; kept for signature compat)
 * @returns {string}
 */
export function getSessionId(hookSessionId) {
  // Claude Code: CLAUDE_CODE_SSE_PORT is unique per session, stable for its lifetime
  if (process.env.CLAUDE_CODE_SSE_PORT) {
    return `cc-${process.env.CLAUDE_CODE_SSE_PORT}`;
  }
  // Fallback: use hook-provided session_id or generate a random one
  return hookSessionId || `session-${randomUUID()}`;
}

// --- MCP protocol ---

export const SERVER_NAME = 'nudge-mcp';
export const SERVER_VERSION = '1.0.0';
export const PROTOCOL_VERSION = '2024-11-05';
