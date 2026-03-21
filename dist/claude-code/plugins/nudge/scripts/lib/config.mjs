/**
 * config.mjs — Config file reader for Nudge plugin
 *
 * Reads and returns the JSON config from ~/.nudge/config.
 * Dependencies: Node.js built-ins only
 */

import { readFileSync } from 'node:fs';
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
