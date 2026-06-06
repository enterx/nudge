#!/usr/bin/env node
/**
 * unwrap-key.mjs — Unwrap the mobile's encryption key during multi-CLI pairing
 *
 * Called by nudge-pair.sh when pairVerify returns multiCli: true. The mobile app
 * has rebound the pairing to its existing UID and returns its encryption key (K1)
 * wrapped with PBKDF2(pairingCode, mobileUid). This helper derives the same
 * wrapping key and unwraps K1 so every paired device shares one key.
 *
 * Usage: echo '{"pairingCode":"...","userId":"...","wrappedKey":"...","wrappingIv":"..."}' | node unwrap-key.mjs
 * Output: base64-encoded encryption key on stdout
 *
 * IMPORTANT: userId MUST be the mobile UID returned by pairVerify (verifyResp.userId),
 * NOT the orphan pairId from pairGenerate — the wrapping key is derived from it.
 *
 * Dependencies: Node.js built-ins only
 */

import { readFileSync } from 'node:fs';
import { deriveWrappingKey, unwrapKey } from './crypto.mjs';

// Read input from stdin (JSON)
let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8').trim();
  input = JSON.parse(raw);
} catch {
  process.stderr.write('Error: Expected JSON on stdin: {"pairingCode","userId","wrappedKey","wrappingIv"}\n');
  process.exit(1);
}

const { pairingCode, userId, wrappedKey, wrappingIv } = input;

if (!pairingCode || !userId || !wrappedKey || !wrappingIv) {
  process.stderr.write('Error: Missing required fields in stdin JSON\n');
  process.exit(1);
}

try {
  // Derive the same wrapping key the mobile used: PBKDF2(pairingCode, mobileUid)
  const wrappingKey = deriveWrappingKey(pairingCode, userId);

  // Unwrap to recover the mobile's encryption key
  const encryptionKey = unwrapKey(wrappedKey, wrappingIv, wrappingKey);

  // Output for bash to capture and save to config
  process.stdout.write(encryptionKey);
} catch (err) {
  process.stderr.write(`Key unwrap failed: ${err.message}\n`);
  process.exit(1);
}
