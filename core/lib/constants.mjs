/**
 * constants.mjs — Shared constants for Nudge plugin
 *
 * Single source of truth for URLs, timeouts, and protocol values.
 * Dependencies: None
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// --- Directories & paths ---

export const NUDGE_CONFIG_DIR =
  process.env.NUDGE_CONFIG_DIR || join(homedir(), '.nudge');

export const CONFIG_PATH =
  process.env.NUDGE_CONFIG_PATH || join(NUDGE_CONFIG_DIR, 'config');

export const LAST_NOTIFY_PATH = join(NUDGE_CONFIG_DIR, 'last_notify');
export const SESSION_ID_PATH = join(NUDGE_CONFIG_DIR, 'session_id');

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
 * Priority: ~/.nudge/session_id file (written by SessionStart hook) →
 * hook-provided session_id → cc-PORT fallback → random UUID.
 *
 * The file-based approach works because the MCP server starts before
 * CLAUDE_ENV_FILE vars are available, but can read files at any time.
 *
 * @param {string} [hookSessionId] - session_id from hook input
 * @returns {string}
 */
export function getSessionId(hookSessionId) {
  // SessionStart hook writes Claude's session_id to ~/.nudge/session_id
  // so both hooks and MCP server read the same unique ID.
  try {
    const fileId = readFileSync(SESSION_ID_PATH, 'utf8').trim();
    if (fileId) return fileId;
  } catch {
    // File doesn't exist yet or read error — fall through
  }
  // Hook-provided session_id (available in hook calls but not MCP)
  if (hookSessionId) {
    return hookSessionId;
  }
  // Fallback: port-based (can be reused across sessions, but stable within one)
  if (process.env.CLAUDE_CODE_SSE_PORT) {
    return `cc-${process.env.CLAUDE_CODE_SSE_PORT}`;
  }
  return `session-${randomUUID()}`;
}

// --- MCP protocol ---

export const SERVER_NAME = 'nudge-mcp';
export const SERVER_VERSION = '1.0.0';
export const PROTOCOL_VERSION = '2024-11-05';
