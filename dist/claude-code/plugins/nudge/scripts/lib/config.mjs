/**
 * config.mjs — Config file reader/writer for Nudge plugin
 *
 * Reads, writes, and updates the JSON config at ~/.nudge/config.
 * Dependencies: Node.js built-ins only
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_PATH, INSTALL_ID_PATH, DEFAULT_API_URL } from './constants.mjs';

/**
 * Read and parse the Nudge config file.
 *
 * @returns {object|null} Parsed config or null if missing/invalid
 */
export function readConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get the API base URL from config, falling back to the default.
 *
 * @param {object|null} config
 * @returns {string}
 */
export function getApiUrl(config) {
  return config?.apiUrl || DEFAULT_API_URL;
}

/**
 * Write the full config object to disk.
 *
 * @param {object} config
 */
export function writeConfig(config) {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Update a single key in the config file.
 *
 * @param {string} key
 * @param {*} value
 */
export function updateConfigKey(key, value) {
  const config = readConfig() || {};
  config[key] = value;
  writeConfig(config);
}

/**
 * Delete the config file.
 */
export function deleteConfig() {
  try { unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
}

/**
 * Get the stable per-computer install ID, creating and persisting one on
 * first use (ADR-003 / M4). This is a plaintext UUIDv4 that identifies this
 * machine across re-pairs; the backend keys users/{uid}/computers/{installId}
 * on it and the mobile app lists / revokes by it. It is intentionally NOT a
 * secret (it never wraps the E2E key) — only an opaque, stable handle.
 *
 * Stored in its OWN file (INSTALL_ID_PATH), not the main config, because
 * `nudge pair` wipes the config on every run — keeping it here would mint a
 * new ID each re-pair and the same machine would show up as multiple computers.
 *
 * Migrates a legacy install ID that was written into the old config location.
 *
 * @returns {string} UUIDv4 install ID
 */
export function getOrCreateInstallId() {
  try {
    const existing = readFileSync(INSTALL_ID_PATH, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // File doesn't exist yet — fall through to create (or migrate).
  }

  // Migrate a legacy ID that older builds stored inside the main config.
  const config = readConfig();
  const legacy = config && typeof config.installId === 'string' ? config.installId.trim() : '';
  const installId = legacy || randomUUID();

  mkdirSync(dirname(INSTALL_ID_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(INSTALL_ID_PATH, installId, { mode: 0o600 });
  return installId;
}
