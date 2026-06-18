/**
 * hook-runtime.mjs — Helpers shared between hook adapters and CLI handlers.
 *
 * The encryption envelope is identical across the CLI (`handlers.mjs`) and
 * the Claude Code hook (`nudge-hook.mjs`). Both call `encryptFields` twice:
 * once for the full RTDB payload (toolInput + description + context + cwd)
 * and once for the small FCM notification payload (description + sessionName).
 *
 * Centralising the helper here keeps the two paths in lockstep — historically
 * they had drifted on minor field choices.
 *
 * Dependencies: Node.js built-ins + ./crypto.mjs only.
 */

import { encryptFields } from './crypto.mjs';

/**
 * Encrypt the sensitive fields of an event payload.
 *
 * @param {object|null} config - Nudge config object; pass `null` to opt out.
 *                                When `config.encryptionKey` is missing,
 *                                returns `null` and callers should send the
 *                                fields in plaintext (back-compat with
 *                                pre-encryption pairings).
 * @param {object} fields - { toolInput, description, context?, cwd?, sessionName? }
 * @returns {{
 *   encryptedPayload: string, iv: string,
 *   encryptedNotif: string, notifIv: string,
 * } | null}
 */
export function encryptSensitiveFields(config, fields) {
  const key = config?.encryptionKey;
  if (!key) return null;

  const full = encryptFields(key, {
    toolInput: fields.toolInput,
    description: fields.description,
    ...(fields.context && { context: fields.context }),
    ...(fields.cwd && { cwd: fields.cwd }),
    ...(fields.sessionName && { sessionName: fields.sessionName }),
    ...(fields.structured && { structured: fields.structured }),
    ...(fields.attachments && fields.attachments.length > 0 && { attachments: fields.attachments }),
    ...(fields.availableSkills && fields.availableSkills.length > 0 && { availableSkills: fields.availableSkills }),
  });

  const notif = encryptFields(key, {
    description: fields.description,
    ...(fields.sessionName && { sessionName: fields.sessionName }),
  });

  return {
    encryptedPayload: full.encryptedPayload,
    iv: full.iv,
    encryptedNotif: notif.encryptedPayload,
    notifIv: notif.iv,
  };
}

/**
 * Build the `eventsCreate` payload by overlaying an encrypted envelope on
 * top of a plaintext base, or falling back to inline plaintext when
 * encryption is not configured.
 *
 * @param {object} args
 * @param {object} args.base - Always-plaintext fields (pluginVersion,
 *                              toolName, pattern, sessionId, ...).
 * @param {object} args.sensitive - Fields that should be encrypted
 *                                   when possible (toolInput, description,
 *                                   context, cwd, sessionName).
 * @param {object|null} args.config - Nudge config for encryption lookup.
 * @param {string} args.fallbackDescription - Public-facing stand-in shown
 *                                             when payload is encrypted.
 * @returns {object} Ready-to-POST event payload.
 */
export function buildEventPayload({ base, sensitive, config, fallbackDescription }) {
  const encrypted = encryptSensitiveFields(config, sensitive);
  if (encrypted) {
    return {
      ...base,
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      encryptedNotif: encrypted.encryptedNotif,
      notifIv: encrypted.notifIv,
      toolInput: {},
      description: fallbackDescription,
    };
  }
  return { ...base, ...sensitive };
}
