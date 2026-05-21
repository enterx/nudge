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
 * here (callers don't need to hash themselves). `sessionId` is also
 * stored in the body so `listAllPending` can group across sessions
 * without parsing the filename.
 */
export function writePending(sessionId, eventId, {
  apiUrl, token, pattern, toolUseId, toolName, toolInput, sessionName,
}) {
  const toolInputHash = hashToolInput(toolInput, toolName);
  try {
    writeFileSync(
      pendingFilePath(sessionId, eventId),
      JSON.stringify({
        eventId,
        sessionId,
        ...(sessionName && { sessionName }),
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

function pendingFileNames(filter = () => true) {
  try {
    return readdirSync(NUDGE_DIR).filter(
      (f) => f.startsWith('pending-') && f.endsWith('.json') && filter(f),
    );
  } catch {
    return [];
  }
}

function parsePendingFile(basename) {
  const fullPath = join(NUDGE_DIR, basename);
  try {
    const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
    if (!data.sessionId) {
      // Best-effort fallback for pre-1.2 pending files (sessionId only in name).
      const stripped = basename.slice('pending-'.length, -'.json'.length);
      const lastDash = stripped.lastIndexOf('-');
      if (lastDash > 0) data.sessionId = stripped.slice(0, lastDash);
    }
    return { file: fullPath, data };
  } catch {
    return null;
  }
}

/**
 * Return every pending event under `~/.nudge`, decoded from disk.
 * The `sessionId` field comes from the JSON body when present;
 * otherwise it falls back to the prefix in the filename
 * (`pending-{sessionId}-{eventId}.json`) so older files still group correctly.
 * Files that fail to parse are skipped silently.
 */
export function listAllPending() {
  return pendingFileNames().map(parsePendingFile).filter(Boolean);
}

/**
 * Find pending events whose `eventId` matches. Walks the directory listing
 * (cheap) and only parses files whose name ends with `-{eventId}.json`, so
 * a targeted `nudge cancel <event-id>` doesn't pay for parsing unrelated
 * sessions' pending files.
 */
export function findPendingByEventId(eventId) {
  const suffix = `-${eventId}.json`;
  return pendingFileNames((f) => f.endsWith(suffix))
    .map(parsePendingFile)
    .filter((entry) => entry && entry.data.eventId === eventId);
}

/**
 * Return every pending event for `sessionId`, decoded from disk.
 * Files that fail to parse are skipped silently.
 */
export function listPendingForSession(sessionId) {
  const prefix = `pending-${sessionId}-`;
  return pendingFileNames((f) => f.startsWith(prefix))
    .map(parsePendingFile)
    .filter(Boolean);
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
