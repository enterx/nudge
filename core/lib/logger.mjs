/**
 * logger.mjs — File-based logger for Nudge plugin
 *
 * Creates named loggers that write to ~/.nudge/<name>.log
 * Dependencies: Node.js built-ins only
 */

import { appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let dirEnsured = false;

function ensureLogDir() {
  if (dirEnsured) return;
  dirEnsured = true; // Don't retry on failure
  const dir = join(homedir(), '.nudge');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
}

/**
 * Create a named logger that writes to ~/.nudge/<name>.log
 *
 * @param {string} name - Log file name (without extension)
 * @returns {{ log: (msg: string) => void }}
 */
export function createLogger(name) {
  const logPath = join(homedir(), '.nudge', `${name}.log`);

  return {
    log(msg) {
      try {
        ensureLogDir();
        appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, {
          mode: 0o600,
        });
      } catch {
        /* ignore — logging must never break the caller */
      }
    },
  };
}
