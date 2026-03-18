#!/usr/bin/env node
/**
 * nudge-cancel-pending.mjs — PostToolUse / PostToolUseFailure hook for Claude Code
 *
 * When a tool completes or is cancelled, any pending mobile events for this
 * session should be cancelled. Scans for all pending-{sessionId}-*.json files
 * to support parallel tool calls (Agent subprocesses).
 *
 * Runs async so it never blocks tool execution.
 * Dependencies: None (Node.js built-ins only)
 */

import { readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './lib/logger.mjs';
import { getSessionId } from './lib/constants.mjs';

const { log } = createLogger('hook-debug');

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf-8').trim();
  if (!input) process.exit(0);

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const sessionId = getSessionId(hookData.session_id);
  const nudgeDir = join(homedir(), '.nudge');
  const prefix = `pending-${sessionId}-`;

  // Find all pending files for this session
  let pendingFiles;
  try {
    pendingFiles = readdirSync(nudgeDir).filter(
      (f) => f.startsWith(prefix) && f.endsWith('.json'),
    );
  } catch {
    process.exit(0);
  }

  if (pendingFiles.length === 0) process.exit(0);

  // Cancel each pending event
  await Promise.all(
    pendingFiles.map(async (file) => {
      const filePath = join(nudgeDir, file);
      let pending;
      try {
        pending = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        return;
      }

      const { eventId, apiUrl, token } = pending;
      if (!eventId || !apiUrl || !token) return;

      // Delete file first to avoid duplicate cancels
      try { unlinkSync(filePath); } catch { /* ignore */ }

      log(`PostToolUse: cancelling bypassed event ${eventId}`);
      try {
        await fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action: 'cancelled', reason: 'Approved in terminal' }),
          signal: AbortSignal.timeout(5_000),
        });
        log(`PostToolUse: event ${eventId} cancelled successfully`);
      } catch (err) {
        log(`PostToolUse: cancel failed for ${eventId}: ${err.message}`);
      }
    }),
  );
}

main().catch(() => process.exit(0));
