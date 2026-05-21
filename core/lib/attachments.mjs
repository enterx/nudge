/**
 * attachments.mjs — Inline file/image attachments for Nudge events.
 *
 * Reads a file off the local filesystem, validates size, hashes it, and
 * returns the shape carried inside the encrypted inner JSON:
 *
 *   { filename, mime, sizeBytes, sha256, dataBase64 }
 *
 * Mobile decrypts and renders. Sizes are bounded for the inline path —
 * larger payloads should eventually land via signed-URL Storage (future).
 *
 * Dependencies: Node.js built-ins only.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

// 2MB raw → ~2.7MB base64 → ~3MB encryptedPayload (RTDB practical ceiling).
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.csv': 'text/csv',
};

export function mimeFromPath(path) {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = path.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Read, validate, and encode a file as an attachment object.
 *
 * Throws a user-readable error on missing file, non-regular file
 * (directory, symlink to nowhere, …), or oversize file.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.maxBytes=MAX_ATTACHMENT_BYTES]
 * @returns {{ filename: string, mime: string, sizeBytes: number, sha256: string, dataBase64: string }}
 */
export function loadAttachment(filePath, options = {}) {
  const { maxBytes = MAX_ATTACHMENT_BYTES } = options;

  let stat;
  try {
    stat = statSync(filePath);
  } catch (err) {
    throw new Error(`attachment: cannot read "${filePath}": ${err.message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`attachment: "${filePath}" is not a regular file`);
  }
  if (stat.size > maxBytes) {
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    const limitMB = (maxBytes / 1024 / 1024).toFixed(0);
    throw new Error(
      `attachment: "${filePath}" is ${sizeMB}MB, exceeds the ${limitMB}MB inline ` +
      `limit (Storage-backed attachments coming in a future release)`,
    );
  }

  const buf = readFileSync(filePath);
  return {
    filename: basename(filePath),
    mime: mimeFromPath(filePath),
    sizeBytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    dataBase64: buf.toString('base64'),
  };
}
