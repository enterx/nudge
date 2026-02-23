#!/usr/bin/env node
/**
 * nudge-activity.mjs — PreToolUse async hook for Claude Code
 *
 * Sends lightweight notification events for WebSearch/WebFetch tool calls
 * so the user can see what Claude is doing on their phone.
 *
 * Runs with async: true — does NOT block tool execution.
 * Dependencies: None (Node.js built-ins only)
 */

import { PROVIDER } from './lib/constants.mjs';
import { readConfig, getApiUrl } from './lib/config.mjs';
import { getValidToken } from './lib/token-utils.mjs';
import { extractSessionName } from './lib/transcript.mjs';

// --- Main ---

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

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const sessionId = hookData.session_id || 'unknown';
  const cwd = hookData.cwd;
  const transcriptPath = hookData.transcript_path;

  if (!toolName) { process.stderr.write('Nudge activity: no tool_name\n'); process.exit(0); }

  const config = readConfig();
  if (!config) { process.stderr.write('Nudge activity: no config\n'); process.exit(0); }

  const token = await getValidToken(config);
  if (!token) { process.stderr.write('Nudge activity: no token\n'); process.exit(0); }

  const apiUrl = getApiUrl(config);
  process.stderr.write(`Nudge activity: sending ${toolName} to ${apiUrl}\n`);

  // Build a human-readable description per tool type
  let description = toolName;
  let body = '';

  if (toolName === 'WebSearch') {
    const query = toolInput.query || '';
    description = `Searching: ${query}`;
    body = query;
  } else if (toolName === 'WebFetch') {
    const url = toolInput.url || '';
    const prompt = toolInput.prompt || '';
    description = `Fetching: ${url}`;
    body = prompt ? `${url}\n\n${prompt}` : url;
  }

  const sessionName = extractSessionName(transcriptPath);

  const payload = {
    title: description,
    body: body || description,
    level: 'info',
    ...(sessionName && { sessionName }),
  };

  // Fire-and-forget POST — push-only, no RTDB event
  try {
    const resp = await fetch(`${apiUrl}/pushNotifyFn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    process.stderr.write(`Nudge activity: HTTP ${resp.status}\n`);
  } catch (err) {
    process.stderr.write(`Nudge activity: fetch error — ${err.message}\n`);
  }
}

main().catch(() => process.exit(0));
