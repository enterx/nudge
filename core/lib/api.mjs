/**
 * api.mjs — HTTP helper for Nudge backend API
 *
 * Dependencies: Node.js built-ins only
 */

import { API_TIMEOUT_MS } from './constants.mjs';

/**
 * POST JSON to a Nudge API endpoint.
 *
 * @param {string} apiUrl  - Base URL (e.g. https://us-central1-...)
 * @param {string} endpoint - Endpoint path (e.g. 'eventsCreate')
 * @param {object} body    - Request body
 * @param {string} [token] - Bearer token (optional)
 * @returns {Promise<object>} Parsed JSON response
 */
export async function apiPost(apiUrl, endpoint, body, token) {
  const resp = await fetch(`${apiUrl}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status}: ${errBody}`);
  }

  return resp.json();
}
