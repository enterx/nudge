/**
 * register-computer.mjs — Register this machine in the paired-computers list
 *
 * ADR-003 / M4. After pairing succeeds, this CLI announces itself to the
 * backend so the mobile app can list "which computers are paired" and revoke
 * any one of them. The machine metadata (hostname / os / arch) is E2E-encrypted
 * with the shared key K before upload — the server only ever sees ciphertext.
 * The installId (a plaintext UUIDv4 handle) is the document key.
 *
 * Dependencies: api.mjs, crypto.mjs, config.mjs, Node.js built-ins
 */

import { hostname as osHostname, platform as osPlatform, arch as osArch } from 'node:os';

import { apiPost } from './api.mjs';
import { encryptFields } from './crypto.mjs';
import { getOrCreateInstallId } from './config.mjs';

/**
 * Map Node's os.platform() value to a friendly OS label for the mobile list.
 *
 * @param {string} platform - os.platform() value
 * @returns {string}
 */
function friendlyOs(platform) {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

/**
 * Collect this machine's display metadata.
 *
 * @returns {{ hostname: string, os: string, arch: string }}
 */
export function collectComputerMeta() {
  return {
    hostname: osHostname(),
    os: friendlyOs(osPlatform()),
    arch: osArch(),
  };
}

/**
 * Register (or refresh) this computer in users/{uid}/computers/{installId}.
 *
 * Idempotent: safe to call on every pair (first-pair and multi-CLI). The
 * backend sets pairedAt only on first insert, refreshes lastSeenAt, and clears
 * any prior revocation. Failures are non-fatal to pairing — the caller should
 * treat a thrown error as "list entry not created yet" and continue, since the
 * core pairing (token + key) already succeeded by the time this runs.
 *
 * @param {string} apiUrl - Base API URL
 * @param {string} encryptionKeyBase64 - Shared E2E key K (base64)
 * @param {string} idToken - Firebase ID token for the shared UID
 * @returns {Promise<{ installId: string }>}
 */
export async function registerComputer(apiUrl, encryptionKeyBase64, idToken) {
  const installId = getOrCreateInstallId();
  const meta = collectComputerMeta();
  const { encryptedPayload, iv } = encryptFields(encryptionKeyBase64, meta);

  await apiPost(
    apiUrl,
    'pairRegisterComputer',
    { installId, encMeta: encryptedPayload, metaIv: iv },
    idToken,
  );

  return { installId };
}
