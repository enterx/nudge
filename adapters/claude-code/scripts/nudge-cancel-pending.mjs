#!/usr/bin/env node
/**
 * nudge-cancel-pending.mjs — PostToolUse hook for Claude Code
 *
 * When a tool executes successfully, it means the PermissionRequest was
 * resolved (either via mobile or terminal). If a pending event file exists,
 * the user responded via terminal and the mobile card needs to be cancelled.
 *
 * Runs async so it never blocks tool execution.
 * Dependencies: None (Node.js built-ins only)
 */

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './lib/logger.mjs';

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

  const sessionId = hookData.session_id || 'unknown';
  const pendingPath = join(homedir(), '.nudge', `pending-${sessionId}.json`);

  // Read pending event
  let pending;
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf-8'));
  } catch {
    // No pending event — nothing to cancel
    process.exit(0);
  }

  const { eventId, apiUrl, token } = pending;
  if (!eventId || !apiUrl || !token) {
    process.exit(0);
  }

  // Delete pending file first to avoid duplicate cancels
  try { unlinkSync(pendingPath); } catch { /* ignore */ }

  // Cancel the event on the backend
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
}

main().catch(() => process.exit(0));
