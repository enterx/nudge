#!/usr/bin/env node
/**
 * nudge-cancel-pending.mjs — PostToolUse hook for Codex CLI
 *
 * When a tool completes, resolves any pending mobile events for this session.
 * Codex CLI does not have a separate PostToolUseFailure event, so this hook
 * handles both success and failure cases by inspecting the tool_response.
 *
 * Runs synchronously (Codex does not support async hooks).
 * Dependencies: None (Node.js built-ins only)
 */

import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSessionId } from './lib/constants.mjs';

function hashToolInput(input) {
  if (!input) return '';
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

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

  const currentToolUseId = hookData.tool_use_id;
  const currentToolInputHash = hashToolInput(hookData.tool_input);

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

  // Resolve each pending event with the correct action
  await Promise.all(
    pendingFiles.map(async (file) => {
      const filePath = join(nudgeDir, file);
      let pending;
      try {
        pending = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        return;
      }

      const { eventId, apiUrl, token, toolUseId, toolInputHash: pendingToolInputHash } = pending;
      if (!eventId || !apiUrl || !token) return;

      // Matching logic: toolUseId match or toolInputHash match
      const isStaleByToolId = toolUseId && currentToolUseId && toolUseId !== currentToolUseId;
      const isHashMatch = pendingToolInputHash && currentToolInputHash && pendingToolInputHash === currentToolInputHash;
      const isToolIdMatch = toolUseId && currentToolUseId && toolUseId === currentToolUseId;

      const isCurrentTool = isToolIdMatch || (!toolUseId && isHashMatch);

      if (!isCurrentTool && !isStaleByToolId) {
        return;
      }

      // Delete pending file before resolving to avoid duplicate responses
      try { unlinkSync(filePath); } catch { /* ignore */ }

      let body;
      if (isStaleByToolId) {
        body = { action: 'cancelled', reason: 'Cancelled in terminal' };
      } else {
        body = { action: 'approved', reason: 'Approved in terminal' };
      }

      try {
        await fetch(`${apiUrl}/eventsRespond/${eventId}/respond`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5_000),
        });
      } catch { /* best-effort */ }
    }),
  );
}

main().catch(() => process.exit(0));
