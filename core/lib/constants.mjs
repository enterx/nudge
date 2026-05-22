/**
 * constants.mjs — Shared constants for Nudge plugin
 *
 * Single source of truth for URLs, timeouts, and protocol values.
 * Dependencies: None
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// --- Directories & paths ---

export const NUDGE_CONFIG_DIR =
  process.env.NUDGE_CONFIG_DIR || join(homedir(), '.nudge');

export const CONFIG_PATH =
  process.env.NUDGE_CONFIG_PATH || join(NUDGE_CONFIG_DIR, 'config');

export const LAST_NOTIFY_PATH = join(NUDGE_CONFIG_DIR, 'last_notify');

// Per-session file keyed by parent PID (= host AI tool process PID).
// Host integrations and MCP server can share the same parent process,
// so process.ppid is the shared unique key. This avoids the port-reuse
// problem where multiple sessions share CLAUDE_CODE_SSE_PORT.
const ppid = process.ppid || '';
export const SESSION_ID_PATH = join(
  NUDGE_CONFIG_DIR,
  ppid ? `session_id.${ppid}` : 'session_id',
);

export const SESSION_NAME_PATH = join(
  NUDGE_CONFIG_DIR,
  ppid ? `session_name.${ppid}` : 'session_name',
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

const PROVIDER_COMMAND_MATCHERS = [
  ['codex', /(?:^|[/\s])codex(?:$|[/\s-])/i],
  ['claude-code', /(?:^|[/\s])claude(?:$|[/\s-])/i],
];

const SHELL_COMMAND_PATTERN = /(?:^|[/\s])(?:ba|z|fi)?sh(?:$|[/\s-])/i;

function detectProviderFromEnv(env) {
  const override = env.NUDGE_PROVIDER?.trim();
  if (override) return override;

  if (env.GITHUB_ACTIONS) return 'github-actions';
  if (env.GITLAB_CI) return 'gitlab-ci';
  if (env.CIRCLECI) return 'circleci';
  if (env.BUILDKITE) return 'buildkite';
  if (env.JENKINS_URL || env.JENKINS_HOME) return 'jenkins';
  if (env.CI) return 'ci';

  return undefined;
}

function getParentCommands(startPid = process.ppid, maxDepth = 6) {
  const commands = [];
  let pid = Number(startPid);
  for (let depth = 0; Number.isFinite(pid) && pid > 1 && depth < maxDepth; depth += 1) {
    try {
      const output = execFileSync(
        'ps',
        ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='],
        { encoding: 'utf8', timeout: 1000 },
      ).trim();
      if (!output) break;
      const match = output.match(/^(\d+)\s+(.+)$/);
      if (!match) break;
      pid = Number(match[1]);
      commands.push(match[2]);
    } catch {
      break;
    }
  }
  return commands;
}

function detectProviderFromParentCommands(commands) {
  for (const command of commands) {
    // If the CLI was launched from an interactive shell, treat it as a
    // manual terminal run. Do not attribute it to the shell's parent app.
    if (SHELL_COMMAND_PATTERN.test(command)) return undefined;
    for (const [provider, pattern] of PROVIDER_COMMAND_MATCHERS) {
      if (pattern.test(command)) return provider;
    }
  }
  return undefined;
}

export function detectProvider({
  env = process.env,
  parentCommands = getParentCommands(),
} = {}) {
  return detectProviderFromEnv(env) || detectProviderFromParentCommands(parentCommands);
}

export const PROVIDER = detectProvider();

// --- Session ---

const FALLBACK_SESSION_ID = randomUUID();

/**
 * Derive a deterministic session ID from the host tool or terminal environment.
 *
 * Priority: host-provided session_id → NUDGE_SESSION_ID →
 * host-AI stable env (Claude Code / Codex) →
 * per-parent session file → terminal session env →
 * per-parent persisted CLI session → process-stable random UUID.
 *
 * Host AI tools (Claude Code, Codex) spawn a fresh shell per Bash invocation,
 * so process.ppid differs every call. Those hosts expose a per-session UUID in
 * the environment (CLAUDE_CODE_SESSION_ID / CODEX_COMPANION_SESSION_ID) that
 * stays stable for the lifetime of the session — prefer it over the per-ppid
 * fallback so all CLI calls in one host session share one session ID.
 *
 * @param {string} [hostSessionId] - session_id from host input
 * @returns {string}
 */
export function getSessionId(hostSessionId) {
  // Host integrations can provide session_id directly.
  if (hostSessionId) {
    return hostSessionId;
  }
  if (process.env.NUDGE_SESSION_ID) {
    return process.env.NUDGE_SESSION_ID;
  }
  // Claude Code / Codex expose a stable per-session UUID across spawned shells.
  if (process.env.CLAUDE_CODE_SESSION_ID) {
    return process.env.CLAUDE_CODE_SESSION_ID;
  }
  if (process.env.CODEX_COMPANION_SESSION_ID) {
    return process.env.CODEX_COMPANION_SESSION_ID;
  }
  // MCP server: read from per-parent file when an integration writes one.
  try {
    const fileId = readFileSync(SESSION_ID_PATH, 'utf8').trim();
    if (fileId) return fileId;
  } catch {
    // File doesn't exist yet or read error — fall through
  }
  // macOS Terminal/iTerm set a stable per-tab session ID.
  if (process.env.TERM_SESSION_ID) {
    return `term-${process.env.TERM_SESSION_ID}`;
  }
  try {
    mkdirSync(NUDGE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(SESSION_ID_PATH, FALLBACK_SESSION_ID, { mode: 0o600 });
    return FALLBACK_SESSION_ID;
  } catch {
    // If persistence fails, keep the value stable within this process.
  }
  return FALLBACK_SESSION_ID;
}

// --- MCP protocol ---

export const SERVER_NAME = 'nudge-mcp';
export const SERVER_VERSION = '1.2.0';
export const PROTOCOL_VERSION = '2024-11-05';
