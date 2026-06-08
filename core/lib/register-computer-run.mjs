#!/usr/bin/env node
/**
 * register-computer-run.mjs — CLI entry-point to register this machine
 *
 * Called by nudge-pair.sh after a successful pair. Encrypts this machine's
 * metadata (hostname / os / arch) with the shared key and POSTs it to
 * pairRegisterComputer so the mobile app can list and revoke it (ADR-003 / M4).
 *
 * Usage: echo '{"apiUrl":"...","encryptionKey":"...","token":"..."}' | node register-computer-run.mjs
 * Output: the installId on stdout (best-effort). Exits 0 on success, 1 on failure.
 *
 * Registration is non-fatal to pairing: the caller ignores a non-zero exit and
 * still reports "Paired!", since the core pairing already succeeded.
 *
 * Dependencies: register-computer.mjs, Node.js built-ins only
 */

import { readFileSync } from 'node:fs';
import { registerComputer } from './register-computer.mjs';

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8').trim();
  input = JSON.parse(raw);
} catch {
  process.stderr.write('Error: Expected JSON on stdin: {"apiUrl","encryptionKey","token"}\n');
  process.exit(1);
}

const { apiUrl, encryptionKey, token } = input;

if (!apiUrl || !encryptionKey || !token) {
  // No encryption key means E2E setup was skipped — nothing to register.
  process.stderr.write('Skipping computer registration: missing apiUrl/encryptionKey/token\n');
  process.exit(1);
}

try {
  const { installId } = await registerComputer(apiUrl, encryptionKey, token);
  process.stdout.write(installId);
} catch (err) {
  process.stderr.write(`Computer registration failed: ${err.message}\n`);
  process.exit(1);
}
