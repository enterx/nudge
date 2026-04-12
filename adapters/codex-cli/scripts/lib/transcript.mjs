/**
 * transcript.mjs — Session name extractor stub for Codex CLI
 *
 * Codex CLI's transcript format differs from Claude Code's.
 * This stub returns null; session name is derived from cwd instead.
 *
 * Dependencies: Node.js built-ins only
 */

/**
 * Extract the session name from a Codex CLI transcript file.
 *
 * @param {string} transcriptPath - Absolute path to the transcript file
 * @returns {string|null} The session name, or null
 */
export function extractSessionName(transcriptPath) {
  // Codex CLI transcript format is not yet documented.
  // Session name is derived from cwd in the hook scripts instead.
  return null;
}
