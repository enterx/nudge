/**
 * logger.mjs — File-based logger for Nudge plugin
 *
 * Creates named loggers that write to ~/.nudge/<name>.log
 * Dependencies: Node.js built-ins only
 */

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
        appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
      } catch {
        /* ignore — logging must never break the caller */
      }
    },
  };
}
