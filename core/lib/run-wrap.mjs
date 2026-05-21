/**
 * run-wrap.mjs — Child-process wrapper for `nudge run`.
 *
 * Spawns the user's command with stdio piped, tees output to the parent
 * terminal in real time, and captures the last N non-empty lines from
 * stdout + stderr for the post-run notification. Returns a summary the
 * CLI can hand to `runNotify` / `runApprove`.
 *
 * Dependencies: Node.js built-ins only.
 */

import { spawn } from 'node:child_process';

class RingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(0, capacity | 0);
    this.items = [];
  }
  push(item) {
    if (this.capacity === 0) return;
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  toArray() {
    return this.items.slice();
  }
}

/**
 * Spawn `cmd argv`, pipe stdio through to the parent terminal, and capture
 * the last `tailLines` non-empty stdout+stderr lines. Resolves with
 * `{ exitCode, signal, durationMs, tail }`.
 *
 * @param {string} cmd
 * @param {string[]} argv
 * @param {object} [options]
 * @param {number} [options.tailLines=50]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.cwd]
 */
export function runWrappedCommand(cmd, argv, options = {}) {
  const { tailLines = 50, env = process.env, cwd } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tail = new RingBuffer(tailLines);

    let child;
    try {
      child = spawn(cmd, argv, {
        env,
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdoutPartial = '';
    let stderrPartial = '';

    const ingest = (chunk, sink, partial) => {
      sink.write(chunk);
      const text = partial + chunk.toString('utf8');
      const lines = text.split('\n');
      const remaining = lines.pop();
      for (const line of lines) {
        if (line.length > 0) tail.push(line);
      }
      return remaining;
    };

    child.stdout.on('data', (chunk) => {
      stdoutPartial = ingest(chunk, process.stdout, stdoutPartial);
    });
    child.stderr.on('data', (chunk) => {
      stderrPartial = ingest(chunk, process.stderr, stderrPartial);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (stdoutPartial.length > 0) tail.push(stdoutPartial);
      if (stderrPartial.length > 0) tail.push(stderrPartial);
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - startedAt,
        tail: tail.toArray(),
      });
    });
  });
}
