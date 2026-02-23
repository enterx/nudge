/**
 * transcript.mjs — Pure JS session name extractor
 *
 * Replaces the previous `tail | jq` shell-out approach, eliminating
 * the jq dependency from the Node.js side.
 *
 * Dependencies: Node.js built-ins only
 */

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

const TAIL_BYTES = 16_384; // Read last 16 KB of transcript

/**
 * Extract the most recent sessionName from a Claude Code transcript file.
 *
 * The transcript is JSONL — one JSON object per line. We scan the last
 * chunk for assistant messages containing tool_use blocks with a
 * sessionName input parameter.
 *
 * @param {string} transcriptPath - Absolute path to the transcript JSONL file
 * @returns {string|null} The most recent sessionName, or null
 */
export function extractSessionName(transcriptPath) {
  if (!transcriptPath) return null;

  try {
    const stat = statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return null;

    // Read the tail of the file to avoid loading huge transcripts
    let raw;
    if (stat.size <= TAIL_BYTES) {
      raw = readFileSync(transcriptPath, 'utf-8');
    } else {
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
      closeSync(fd);
      raw = buf.toString('utf-8');
    }

    const lines = raw.split('\n');
    let lastSessionName = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // Partial line from tail read — skip
      }

      if (entry.type !== 'assistant') continue;

      const contents = entry.message?.content;
      if (!Array.isArray(contents)) continue;

      for (const block of contents) {
        if (block.type === 'tool_use' && block.input?.sessionName) {
          lastSessionName = block.input.sessionName;
        }
      }
    }

    return lastSessionName;
  } catch {
    return null;
  }
}
