/**
 * crypto.mjs — E2E encryption for Nudge plugin
 *
 * AES-256-GCM encryption. Keys never leave the user's machine.
 * This code is open-source so users can audit the encryption.
 *
 * Dependencies: Node.js built-in crypto only
 */

import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';

/** GCM auth tag length in bytes — appended to the ciphertext by wrapKey/encryptFields */
const GCM_TAG_BYTES = 16;

/** PBKDF2 iterations — high enough to resist brute-force on the 40-bit pairing code */
const PBKDF2_ITERATIONS = 600_000;

/**
 * Generate a random AES-256 encryption key (32 bytes).
 * @returns {string} Base64-encoded key
 */
export function generateEncryptionKey() {
  return randomBytes(32).toString('base64');
}

/**
 * Derive a wrapping key from pairing code and userId using PBKDF2.
 * Used to securely transfer the encryption key during pairing.
 *
 * The pairing code has ~40 bits of entropy. PBKDF2 with 600k iterations
 * makes brute-force infeasible within the 10-minute code expiry window.
 *
 * @param {string} pairingCode - The 8-char pairing code (with or without hyphen)
 * @param {string} userId - Firebase user ID (used as salt)
 * @returns {Buffer} 32-byte derived key
 */
export function deriveWrappingKey(pairingCode, userId) {
  const raw = pairingCode.replace(/-/g, '').toUpperCase();
  return pbkdf2Sync(raw, userId, PBKDF2_ITERATIONS, 32, 'sha256');
}

/**
 * Wrap (encrypt) the encryption key for safe transfer via server.
 * The server stores the ciphertext but cannot derive the wrapping key.
 *
 * @param {string} encryptionKeyBase64 - Base64-encoded AES-256 key to wrap
 * @param {Buffer} wrappingKey - 32-byte wrapping key from deriveWrappingKey()
 * @returns {{ wrappedKey: string, wrappingIv: string }} Base64-encoded wrapped key and IV
 */
export function wrapKey(encryptionKeyBase64, wrappingKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(encryptionKeyBase64, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Concatenate ciphertext + authTag for compact storage
  const wrapped = Buffer.concat([encrypted, authTag]);
  return {
    wrappedKey: wrapped.toString('base64'),
    wrappingIv: iv.toString('base64'),
  };
}

/**
 * Unwrap (decrypt) an encryption key that was wrapped with wrapKey().
 *
 * Used during multi-CLI pairing: the mobile app wraps its existing encryption
 * key (K1) with a key derived from the pairing code + mobile UID and returns it
 * via pairVerify. This CLI unwraps it so all devices share the same key.
 *
 * @param {string} wrappedKeyBase64 - Base64-encoded wrapped key (ciphertext + authTag)
 * @param {string} wrappingIvBase64 - Base64-encoded IV used during wrapping
 * @param {Buffer} wrappingKey - 32-byte wrapping key from deriveWrappingKey()
 * @returns {string} Base64-encoded AES-256 encryption key (the original plaintext)
 */
export function unwrapKey(wrappedKeyBase64, wrappingIvBase64, wrappingKey) {
  const wrapped = Buffer.from(wrappedKeyBase64, 'base64');
  const iv = Buffer.from(wrappingIvBase64, 'base64');
  const ciphertext = wrapped.subarray(0, wrapped.length - GCM_TAG_BYTES);
  const authTag = wrapped.subarray(wrapped.length - GCM_TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypt sensitive event fields before sending to the server.
 *
 * Encrypted fields: toolInput, description, context, cwd
 * These are combined into a single JSON payload, encrypted, and replaced
 * with encryptedPayload + iv in the API request.
 *
 * @param {string} encryptionKeyBase64 - Base64-encoded AES-256 key
 * @param {object} fields - { toolInput, description, context, cwd }
 * @returns {{ encryptedPayload: string, iv: string }} Base64-encoded ciphertext and IV
 */
export function encryptFields(encryptionKeyBase64, fields) {
  const key = Buffer.from(encryptionKeyBase64, 'base64');
  const iv = randomBytes(12);
  const plaintext = JSON.stringify(fields);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const payload = Buffer.concat([encrypted, authTag]);

  return {
    encryptedPayload: payload.toString('base64'),
    iv: iv.toString('base64'),
  };
}
