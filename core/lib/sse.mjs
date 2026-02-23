/**
 * sse.mjs — Firebase RTDB SSE client for Nudge plugin
 *
 * Connects to Firebase RTDB REST Streaming API and waits for a
 * response payload containing an `action` field.
 *
 * Returns raw payload data — callers wrap it as needed.
 *
 * Dependencies: Node.js built-ins only
 */

import { SSE_MAX_TIME_MS, SSE_MAX_RECONNECTS } from './constants.mjs';

/**
 * Wait for a decision response via Firebase RTDB SSE stream.
 *
 * @param {string} rtdbStreamUrl - Firebase RTDB REST streaming URL
 * @param {string} token         - Firebase auth token
 * @returns {Promise<object>} Raw response payload (e.g. { action, reason, ... })
 */
export async function waitForDecision(rtdbStreamUrl, token) {
  if (!rtdbStreamUrl) {
    throw new Error('No RTDB stream URL returned from server');
  }

  let consecutiveFailures = 0;

  while (consecutiveFailures < SSE_MAX_RECONNECTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SSE_MAX_TIME_MS);

    try {
      const separator = rtdbStreamUrl.includes('?') ? '&' : '?';
      const url = `${rtdbStreamUrl}${separator}auth=${encodeURIComponent(token)}`;

      const resp = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        clearTimeout(timeout);
        throw new Error(`HTTP ${resp.status}: ${body}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;

            let msg;
            try {
              msg = JSON.parse(dataStr);
            } catch {
              continue;
            }

            // Reset failure counter on any valid message
            consecutiveFailures = 0;

            // Firebase RTDB format: { path: "/", data: <value> }
            // Initial put has data: null (response not yet written)
            // When mobile responds: data: { action, reason, respondedAt, selectedOptions }
            const payload = msg.data ?? msg;

            if (payload && typeof payload === 'object' && payload.action) {
              clearTimeout(timeout);
              controller.abort();
              return payload;
            }
          }
        }
      } finally {
        reader.releaseLock();
        clearTimeout(timeout);
      }
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        // Timeout — reconnect silently
      } else {
        consecutiveFailures++;
        if (consecutiveFailures >= SSE_MAX_RECONNECTS) {
          // Redact auth tokens from error messages to prevent log leakage
          const safeMsg = err.message.replace(/auth=[^&\s]+/gi, 'auth=[REDACTED]');
          throw new Error(
            `SSE connection failed after ${SSE_MAX_RECONNECTS} attempts: ${safeMsg}`,
          );
        }
        // Exponential backoff
        await new Promise((r) => setTimeout(r, 1000 * consecutiveFailures));
      }
    }
  }

  throw new Error('SSE connection lost: max reconnect attempts exceeded');
}
