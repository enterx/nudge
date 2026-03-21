#!/usr/bin/env node
/**
 * setup-encryption.mjs — Generate and upload wrapped encryption key during pairing
 *
 * Called by nudge-pair.sh during the pairing flow.
 * Generates a random AES-256 key, wraps it with a key derived from the
 * pairing code (which both CLI and mobile know), and uploads the wrapped
 * key to the server. The server never sees the real encryption key.
 *
 * Usage: echo '{"pairingCode":"...","userId":"...","token":"...","apiUrl":"..."}' | node setup-encryption.mjs
 * Output: base64-encoded encryption key on stdout
 *
 * Sensitive args (token) are passed via stdin to avoid ps aux exposure.
 * Dependencies: Node.js built-ins only
 */

import { readFileSync } from 'node:fs';
import { generateEncryptionKey, deriveWrappingKey, wrapKey } from './crypto.mjs';
import { API_TIMEOUT_MS } from './constants.mjs';

// Read input from stdin (JSON)
let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8').trim();
  input = JSON.parse(raw);
} catch {
  process.stderr.write('Error: Expected JSON on stdin: {"pairingCode","userId","token","apiUrl"}\n');
  process.exit(1);
}

const { pairingCode, userId, token, apiUrl } = input;

if (!pairingCode || !userId || !token || !apiUrl) {
  process.stderr.write('Error: Missing required fields in stdin JSON\n');
  process.exit(1);
}

try {
  // 1. Generate random AES-256 key
  const encryptionKey = generateEncryptionKey();

  // 2. Derive wrapping key from pairing code + userId (PBKDF2, 600k iterations)
  const wrappingKey = deriveWrappingKey(pairingCode, userId);

  // 3. Wrap the encryption key
  const { wrappedKey, wrappingIv } = wrapKey(encryptionKey, wrappingKey);

  // 4. Upload wrapped key to server
  const resp = await fetch(`${apiUrl}/pairKeyExchange`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ wrappedKey, wrappingIv }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    process.stderr.write(`Key exchange failed: HTTP ${resp.status} ${errText.slice(0, 200)}\n`);
    process.exit(1);
  }

  // 5. Output encryption key for bash to capture and save to config
  process.stdout.write(encryptionKey);
} catch (err) {
  process.stderr.write(`Key setup failed: ${err.message}\n`);
  process.exit(1);
}
