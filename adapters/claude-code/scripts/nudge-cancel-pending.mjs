#!/usr/bin/env node
/**
 * nudge-cancel-pending.mjs — PostToolUse / PostToolUseFailure hook for Claude Code
 *
 * When a tool completes (or fails/is denied), resolves any pending mobile events
 * for this session with the correct action and response data:
 *   - PostToolUse (approval)     → approved  + reason "Approved in terminal"
 *   - PostToolUseFailure         → denied    + reason "Denied in terminal"
 *   - PostToolUse (elicitation)  → answered  + selectedOptions/reason from tool_response
 *
 * Scans for all pending-{sessionId}-*.json files to support parallel tool calls.
 * Runs async so it never blocks tool execution.
 * Dependencies: None (Node.js built-ins only)
 */

import { readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from './lib/logger.mjs';
import { getSessionId } from './lib/constants.mjs';

const { log } = createLogger('hook-debug');

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

      const { eventId, apiUrl, token, pattern } = pending;
      if (!eventId || !apiUrl || !token) return;

      // Delete file first to avoid duplicate responses
      try { unlinkSync(filePath); } catch { /* ignore */ }

      // Determine the correct action and payload
      let body;
      if (pattern === 'elicitation') {
        const answerData = extractAskUserAnswer(hookData);
        body = {
          action: 'answered',
          reason: answerData.reason ?? 'Answered in terminal',
          ...(answerData.selectedOptions && { selectedOptions: answerData.selectedOptions }),
        };
      } else if (isFailure) {
        body = { action: 'denied', reason: 'Denied in terminal' };
      } else {
        body = { action: 'approved', reason: 'Approved in terminal' };
      }

      log(`PostToolUse: resolving event ${eventId} as ${body.action}`);
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
        log(`PostToolUse: event ${eventId} resolved as ${body.action}`);
      } catch (err) {
        log(`PostToolUse: resolve failed for ${eventId}: ${err.message}`);
      }
    }),
  );
}

main().catch(() => process.exit(0));
