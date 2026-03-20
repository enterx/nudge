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
 * Extract the session name from a Claude Code transcript file.
 *
 * Priority:
 * 1. /rename custom title ({"type":"custom-title","customTitle":"..."})
 *    — scanned from the full file since it can appear at any position
 * 2. Most recent MCP tool_use sessionName from the tail
 *
 * @param {string} transcriptPath - Absolute path to the transcript JSONL file
 * @returns {string|null} The session name, or null
 */
export function extractSessionName(transcriptPath) {
  if (!transcriptPath) return null;

  try {
    const stat = statSync(transcriptPath);
    if (!stat.isFile() || stat.size === 0) return null;

    // 1. Fast full-file scan for custom-title (from /rename command).
    //    Only parse lines containing "custom-title" to stay lightweight.
    const full = readFileSync(transcriptPath, 'utf-8');
    let customTitle = null;
    for (const line of full.split('\n')) {
      if (!line.includes('"custom-title"')) continue;
      try {
        const entry = JSON.parse(line.trim());
        if (entry.type === 'custom-title' && entry.customTitle) {
          customTitle = entry.customTitle;
        }
      } catch { continue; }
    }

    if (customTitle) return customTitle;

    // 2. Tail scan for MCP tool_use sessionName (fallback)
    let raw;
    if (stat.size <= TAIL_BYTES) {
      raw = full; // already loaded
    } else {
      const fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
      closeSync(fd);
      raw = buf.toString('utf-8');
    }

    let lastSessionName = null;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch { continue; }

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
