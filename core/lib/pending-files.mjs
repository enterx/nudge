/**
 * pending-files.mjs — Tracking files for in-flight Nudge events.
 *
 * When a hook creates an event (e.g. PermissionRequest), it persists a
 * `pending-{sessionId}-{eventId}.json` file under `~/.nudge/`. Adjacent
 * hooks (PostToolUse, PostToolUseFailure) and orphan-cleanup paths use
 * these files to resolve events whose lifecycles cross process boundaries.
 *
 * Dependencies: Node.js built-ins only.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const NUDGE_DIR = join(homedir(), '.nudge');

export function pendingFilePath(sessionId, eventId) {
  return join(NUDGE_DIR, `pending-${sessionId}-${eventId}.json`);
}

/**
 * Compute the 16-char prefix of sha256(JSON.stringify(input)). For
 * AskUserQuestion, strip `answers`/`annotations` that PostToolUse appends
 * to the original tool_input — otherwise the hash drifts between
 * PermissionRequest time and PostToolUse time.
 */
export function hashToolInput(input, toolName) {
  if (!input) return '';
  let obj = input;
  if (toolName === 'AskUserQuestion') {
    const { answers, annotations, ...rest } = obj;
    obj = rest;
  }
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/**
 * Persist a pending event for later resolution. `toolInput` is hashed
 * here (callers don't need to hash themselves).
 */
export function writePending(sessionId, eventId, {
  apiUrl, token, pattern, toolUseId, toolName, toolInput,
}) {
  const toolInputHash = hashToolInput(toolInput, toolName);
  try {
    writeFileSync(
      pendingFilePath(sessionId, eventId),
      JSON.stringify({
        eventId,
        apiUrl,
        token,
        pattern,
        toolUseId,
        toolName,
        toolInputHash,
        createdAt: Date.now(),
      }),
      { mode: 0o600 },
    );
  } catch { /* best-effort */ }
}

export function clearPending(sessionId, eventId) {
  try { unlinkSync(pendingFilePath(sessionId, eventId)); } catch { /* ignore */ }
}

/**
 * Return every pending event for `sessionId`, decoded from disk.
 * Files that fail to parse are skipped silently.
 */
export function listPendingForSession(sessionId) {
  const prefix = `pending-${sessionId}-`;
  let files;
  try {
    files = readdirSync(NUDGE_DIR).filter(
      (f) => f.startsWith(prefix) && f.endsWith('.json'),
    );
  } catch {
    return [];
  }
  const result = [];
  for (const file of files) {
    const fullPath = join(NUDGE_DIR, file);
    try {
      const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
      result.push({ file: fullPath, data });
    } catch { /* ignore malformed file */ }
  }
  return result;
}

/**
 * Best-effort POST a cancellation for `eventId` to the backend.
 * Used by orphan cleanup when SIGKILL prevented the originating hook
 * from sending its own cancel.
 */
export function postCancel({ apiUrl, eventId, token, reason = 'Cancelled in terminal' }) {
  return fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action: 'cancelled', reason }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {});
}

/**
 * Cancel every pending event for `sessionId` and remove its tracking
 * file. Called by PermissionRequest hooks at startup to mop up orphans
 * left by SIGKILL on the prior tool call.
 */
export function cancelOrphansForSession(sessionId, reason = 'Cancelled in terminal') {
  for (const { file, data } of listPendingForSession(sessionId)) {
    try { unlinkSync(file); } catch { /* ignore */ }
    if (data.eventId && data.apiUrl && data.token) {
      postCancel({ apiUrl: data.apiUrl, eventId: data.eventId, token: data.token, reason });
    }
  }
}
