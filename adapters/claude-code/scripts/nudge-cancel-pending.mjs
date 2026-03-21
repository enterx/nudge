#!/usr/bin/env node
/**
 * nudge-cancel-pending.mjs — PostToolUse / PostToolUseFailure hook for Claude Code
 *
 * When a tool completes (or fails/is denied), resolves any pending mobile events
 * for this session with the correct action and response data:
 *   - PostToolUse (matching toolUseId)  → approved   + reason "Approved in terminal"
 *   - PostToolUse (stale toolUseId)     → cancelled + reason "Cancelled in terminal"
 *   - PostToolUseFailure + stdin-close  → denied    + reason "Denied in terminal"
 *   - PostToolUseFailure + SIGKILL      → cancelled + reason "Cancelled in terminal"
 *   - PostToolUse (elicitation)         → answered  + selectedOptions/reason from tool_response
 *
 * When a user denies a tool via Terminal (No/Escape), Claude Code does NOT fire
 * PostToolUse/PostToolUseFailure for that tool. The pending file survives until
 * it is cleaned up. Two-tier cleanup strategy:
 *   1. PostToolUse matches its own pending file by toolUseId or toolInputHash
 *      and resolves it. Non-matching pending files are LEFT IN PLACE.
 *   2. The next PermissionRequest hook cleans up ALL remaining pending files
 *      as "denied" (orphan cleanup) — since any approved tool's pending file
 *      would have been resolved by its own PostToolUse already.
 *
 * Scans for all pending-{sessionId}-*.json files to support parallel tool calls.
 * Runs async so it never blocks tool execution.
 * Dependencies: None (Node.js built-ins only)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSessionId } from './lib/constants.mjs';

function hashToolInput(input, toolName) {
  if (!input) return '';
  let obj = input;
  // AskUserQuestion: PostToolUse adds answers/annotations to tool_input
  // that weren't present at PermissionRequest time. Strip them to match.
  if (toolName === 'AskUserQuestion') {
    const { answers, annotations, ...rest } = obj;
    obj = rest;
  }
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/**
 * Extract the user's answer from AskUserQuestion tool_response.
 * Returns { selectedOptions, reason } matching the backend respondToEvent schema.
 */
function extractAskUserAnswer(hookData) {
  const answers = hookData.tool_response?.answers ?? hookData.tool_input?.answers;
  if (!answers || typeof answers !== 'object') return {};

  const questions = hookData.tool_response?.questions ?? hookData.tool_input?.questions;
  const values = Object.values(answers);
  if (values.length === 0) return {};

  // Match answer text to option labels → return option values as selectedOptions
  const selectedOptions = [];
  let reason = null;

  for (const [question, answer] of Object.entries(answers)) {
    const q = questions?.find((qq) => qq.question === question);
    if (q?.options) {
      const opt = q.options.find((o) => o.label === answer);
      if (opt) {
        // Use option value if available, otherwise the label
        selectedOptions.push(opt.value ?? opt.label);
        continue;
      }
    }
    // Free-text answer (Other) or no matching option
    reason = String(answer);
  }

  return {
    ...(selectedOptions.length > 0 && { selectedOptions }),
    ...(reason && { reason }),
  };
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

  const hookEventName = hookData.hook_event_name;
  const isFailure = hookEventName === 'PostToolUseFailure';
  const currentToolUseId = hookData.tool_use_id;
  const currentToolInputHash = hashToolInput(hookData.tool_input, hookData.tool_name);

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

      const { eventId, apiUrl, token, pattern, toolUseId, toolInputHash: pendingToolInputHash } = pending;
      if (!eventId || !apiUrl || !token) return;

      // --- Matching logic ---
      // Two-tier strategy:
      //   1. toolUseId match (when available — e.g. PreToolUse hooks)
      //   2. toolInputHash match (fallback for PermissionRequest which lacks tool_use_id)
      // Non-matching pending files are NOT resolved here — they are cleaned up
      // by the next PermissionRequest hook (orphan cleanup).

      const isStaleByToolId = toolUseId && currentToolUseId && toolUseId !== currentToolUseId;
      const isHashMatch = pendingToolInputHash && currentToolInputHash && pendingToolInputHash === currentToolInputHash;
      const isToolIdMatch = toolUseId && currentToolUseId && toolUseId === currentToolUseId;

      // Determine if this pending file belongs to the current tool
      const isCurrentTool = isToolIdMatch || (!toolUseId && isHashMatch);

      if (!isCurrentTool && !isStaleByToolId) {
        return;
      }

      // Delete pending file before resolving to avoid duplicate responses
      try { unlinkSync(filePath); } catch { /* ignore */ }

      // Determine the correct action and payload
      //
      // For PostToolUseFailure (isFailure=true), distinguish Terminal No vs Escape:
      //   - Terminal No: hook receives stdin-close → writes marker file → 'denied'
      //   - Escape: Claude Code sends SIGKILL → no marker file → 'cancelled'
      // The marker file is written by nudge-hook.mjs in the stdin-close handler.
      const stdinCloseMarker = join(nudgeDir, `stdin-close-${eventId}`);
      const wasStdinClose = existsSync(stdinCloseMarker);
      try { unlinkSync(stdinCloseMarker); } catch { /* may not exist */ }

      let body;
      if (isStaleByToolId) {
        // toolUseId mismatch — definitely stale (orphaned by SIGKILL or previous tool)
        body = { action: 'cancelled', reason: 'Cancelled in terminal' };
      } else if (pattern === 'elicitation') {
        const answerData = extractAskUserAnswer(hookData);
        body = {
          action: 'answered',
          reason: answerData.reason ?? 'Answered in terminal',
          ...(answerData.selectedOptions && { selectedOptions: answerData.selectedOptions }),
        };
      } else if (isFailure) {
        if (wasStdinClose) {
          // Terminal No: user explicitly denied
          body = { action: 'denied', reason: 'Denied in terminal' };
        } else {
          // Escape (SIGKILL): user cancelled, not denied
          body = { action: 'cancelled', reason: 'Cancelled in terminal' };
        }
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
