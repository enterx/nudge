/**
 * token-utils.mjs — JWT decode, expiry check, and token refresh
 *
 * Shared across all three .mjs consumers.
 * Dependencies: Node.js built-ins only
 */

import { writeFileSync } from 'node:fs';
import {
  CONFIG_PATH,
  TOKEN_REFRESH_BUFFER_SECONDS,
  REFRESH_TOKEN_TIMEOUT_MS,
} from './constants.mjs';
import { readConfig } from './config.mjs';

/**
 * Decode the payload section of a JWT (no signature verification).
 *
 * @param {string} token
 * @returns {object|null}
 */
export function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let payload = parts[1];
    const pad = (4 - (payload.length % 4)) % 4;
    if (pad > 0) payload += '='.repeat(pad);
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check whether a token is expired (or will expire within the buffer window).
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isTokenExpired(token) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  return payload.exp < Math.floor(Date.now() / 1000) + TOKEN_REFRESH_BUFFER_SECONDS;
}

/**
 * Refresh the Firebase ID token using the stored refresh token.
 *
 * @param {object} config
 * @returns {Promise<string|null>} New ID token, or null on failure
 */
export async function refreshToken(config) {
  const refreshTok = config?.refreshToken;
  const apiKey = config?.apiKey;
  if (!refreshTok || !apiKey) return null;

  const url = `https://securetoken.googleapis.com/v1/token?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshTok,
    }),
    signal: AbortSignal.timeout(REFRESH_TOKEN_TIMEOUT_MS),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data.id_token) return null;

  // Persist new tokens to config file
  try {
    const currentConfig = readConfig() || {};
    currentConfig.token = data.id_token;
    if (data.refresh_token) {
      currentConfig.refreshToken = data.refresh_token;
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(currentConfig, null, 2), {
      mode: 0o600,
    });
  } catch {
    // Non-fatal: token is still usable for this session
  }

  return data.id_token;
}

/**
 * Get a valid (non-expired) token, refreshing if necessary.
 *
 * @param {object} config
 * @returns {Promise<string|null>}
 */
export async function getValidToken(config) {
  const token = config?.token;
  if (!token) return null;

  if (!isTokenExpired(token)) return token;

  const newToken = await refreshToken(config);
  return newToken || token; // Fall back to expired token (server might still accept)
}
