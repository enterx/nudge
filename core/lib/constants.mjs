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

// Per-session file: session_id.{PORT} to avoid cross-session overwrites.
// Falls back to 'session_id' if no port is available.
const portSuffix = process.env.CLAUDE_CODE_SSE_PORT || '';
export const SESSION_ID_PATH = join(
  NUDGE_CONFIG_DIR,
  portSuffix ? `session_id.${portSuffix}` : 'session_id',
);

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
 *
 * Priority: hook-provided session_id (always unique per session) →
 * per-port file (written by SessionStart/PermissionRequest hook for MCP) →
 * cc-PORT fallback → random UUID.
 *
 * Hooks always receive session_id from Claude Code, so they use that directly.
 * MCP server has no hook input, so it reads from the per-port file.
 *
 * @param {string} [hookSessionId] - session_id from hook input
 * @returns {string}
 */
export function getSessionId(hookSessionId) {
  // Hooks always have session_id — use it directly (no file read needed)
  if (hookSessionId) {
    return hookSessionId;
  }
  // MCP server: read from per-port file (written by hooks)
  try {
    const fileId = readFileSync(SESSION_ID_PATH, 'utf8').trim();
    if (fileId) return fileId;
  } catch {
    // File doesn't exist yet or read error — fall through
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
