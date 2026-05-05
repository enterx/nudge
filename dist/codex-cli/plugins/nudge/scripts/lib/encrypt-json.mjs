#!/usr/bin/env node
/**
 * encrypt-json.mjs — CLI helper to encrypt JSON fields for Bash scripts
 *
 * Reads JSON from stdin, encrypts sensitive fields using the configured
 * encryption key, and outputs the encrypted payload as JSON to stdout.
 *
 * Input (stdin JSON):
 *   { "description": "...", "sessionName": "..." }
 *
 * Output (stdout JSON):
 *   { "encryptedPayload": "...", "iv": "...", "encryptedNotif": "...", "notifIv": "..." }
 *
 * Exit codes:
 *   0 — success (encrypted JSON on stdout)
 *   1 — no encryption key configured (caller should fall back to plaintext)
 *   2 — error
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { encryptFields } from './crypto.mjs';

function readConfig() {
  try {
    const configPath = process.env.NUDGE_CONFIG_PATH
      || join(process.env.NUDGE_CONFIG_DIR || join(homedir(), '.nudge'), 'config');
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return null;
  }
}

try {
  const config = readConfig();
  const key = config?.encryptionKey;
  if (!key) {
    process.exit(1);
  }

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const fields = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

  // Full payload
  const full = encryptFields(key, fields);

  // Small notification payload (description + sessionName only)
  const notifFields = {};
  if (fields.description) notifFields.description = fields.description;
  if (fields.sessionName) notifFields.sessionName = fields.sessionName;
  const notif = encryptFields(key, notifFields);

  const result = {
    encryptedPayload: full.encryptedPayload,
    iv: full.iv,
    encryptedNotif: notif.encryptedPayload,
    notifIv: notif.iv,
  };

  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.exit(2);
}
