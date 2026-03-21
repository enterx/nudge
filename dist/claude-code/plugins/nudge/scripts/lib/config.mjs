/**
 * config.mjs — Config file reader/writer for Nudge plugin
 *
 * Reads, writes, and updates the JSON config at ~/.nudge/config.
 * Dependencies: Node.js built-ins only
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_PATH, DEFAULT_API_URL } from './constants.mjs';

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
