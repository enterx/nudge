/**
 * fixtures.mjs — Test data factories for Nudge plugin tests
 *
 * Provides helpers to create JWTs, config objects, host tool payloads,
 * and SSE message strings. Zero external dependencies.
 */

/**
 * Create a real base64url-encoded JWT with the given payload.
 * No signature verification — just structural correctness.
 *
 * @param {object} payload - JWT payload claims
 * @param {number} [expiresInSeconds] - Seconds until expiry (sets `exp` claim)
 * @returns {string} A three-part dot-separated JWT string
 */
export function createJwt(payload = {}, expiresInSeconds) {
  const header = { alg: 'none', typ: 'JWT' };

  const claims = { ...payload };
  if (expiresInSeconds !== undefined) {
    claims.exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  }

  const encode = (obj) => {
    const json = JSON.stringify(obj);
    return Buffer.from(json)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  };

  return `${encode(header)}.${encode(claims)}.fakesig`;
}

/**
 * Create a config object with sensible defaults.
 *
 * @param {object} [overrides] - Fields to override
 * @returns {object}
 */
export function createConfig(overrides = {}) {
  return {
    token: createJwt({ sub: 'test-user' }, 3600),
    refreshToken: 'fake-refresh-token',
    apiKey: 'fake-api-key',
    apiUrl: 'http://127.0.0.1:9999',
    ...overrides,
  };
}

/**
 * Create a host tool input payload.
 *
 * @param {string} toolName
 * @param {object} [toolInput]
 * @param {object} [extras] - Additional fields (session_id, cwd, etc.)
 * @returns {object}
 */
export function createHostToolPayload(toolName, toolInput = {}, extras = {}) {
  return {
    tool_name: toolName,
    tool_input: toolInput,
    session_id: 'test-session-001',
    cwd: '/tmp/test-project',
    ...extras,
  };
}

/**
 * Format a Server-Sent Events data line.
 *
 * @param {object|string} data - The data to include
 * @returns {string} A properly formatted SSE message string (with trailing newlines)
 */
export function createSSEMessage(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: put\ndata: ${str}\n\n`;
}
