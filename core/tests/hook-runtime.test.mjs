/**
 * Tests for core/lib/hook-runtime.mjs
 *
 * Verifies that the encryption envelope and payload builder produce
 * the shape that both `handlers.mjs` and the Claude Code adapter
 * expect. Uses a deterministic 32-byte key to avoid randomness.
 *
 * Run: node tests/hook-runtime.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { encryptSensitiveFields, buildEventPayload } from '../lib/hook-runtime.mjs';

const KEY = randomBytes(32).toString('base64');

describe('encryptSensitiveFields', () => {
  it('returns null when config has no encryptionKey', () => {
    assert.equal(encryptSensitiveFields(null, { toolInput: {}, description: 'd' }), null);
    assert.equal(encryptSensitiveFields({}, { toolInput: {}, description: 'd' }), null);
    assert.equal(
      encryptSensitiveFields({ encryptionKey: null }, { toolInput: {}, description: 'd' }),
      null,
    );
  });

  it('produces full + notif ciphertext when key is present', () => {
    const out = encryptSensitiveFields(
      { encryptionKey: KEY },
      {
        toolInput: { command: 'ls' },
        description: 'List files',
        context: 'review of /tmp',
        cwd: '/tmp',
        sessionName: 'Cleanup',
      },
    );
    assert.equal(typeof out.encryptedPayload, 'string');
    assert.ok(out.encryptedPayload.length > 0);
    assert.equal(typeof out.iv, 'string');
    assert.equal(typeof out.encryptedNotif, 'string');
    assert.equal(typeof out.notifIv, 'string');
    // The two IVs should be distinct (independent encryptions)
    assert.notEqual(out.iv, out.notifIv);
  });

  it('omits optional fields cleanly (no throw on missing context/cwd/sessionName)', () => {
    const out = encryptSensitiveFields(
      { encryptionKey: KEY },
      { toolInput: {}, description: 'd' },
    );
    assert.ok(out);
    assert.equal(typeof out.encryptedPayload, 'string');
  });

  it('carries structured context fields when provided', async () => {
    // Round-trip via a known key to assert the structured field actually
    // makes it into the encrypted payload's inner JSON.
    const { createDecipheriv } = await import('node:crypto');
    const key = Buffer.from(KEY, 'base64');
    const structured = { diff: '--- a\n+++ b', files: ['a.go'], exitCode: 1, toolName: 'go test' };
    const out = encryptSensitiveFields(
      { encryptionKey: KEY },
      { toolInput: { x: 1 }, description: 'd', structured },
    );
    // Decrypt and parse
    const blob = Buffer.from(out.encryptedPayload, 'base64');
    const iv = Buffer.from(out.iv, 'base64');
    const ciphertext = blob.subarray(0, blob.length - 16);
    const tag = blob.subarray(blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    assert.deepEqual(parsed.structured, structured);
  });
});

describe('buildEventPayload', () => {
  const base = {
    pluginVersion: '1.0.0',
    toolName: 'Bash',
    pattern: 'approval',
    sessionId: 's1',
  };

  it('encrypts when config has a key and substitutes placeholders', () => {
    const payload = buildEventPayload({
      base,
      sensitive: { toolInput: { command: 'rm -rf /' }, description: 'danger' },
      config: { encryptionKey: KEY },
      fallbackDescription: 'Bash requires approval',
    });
    // Base fields preserved
    assert.equal(payload.toolName, 'Bash');
    assert.equal(payload.sessionId, 's1');
    // Encrypted envelope present
    assert.equal(typeof payload.encryptedPayload, 'string');
    assert.equal(typeof payload.iv, 'string');
    assert.equal(typeof payload.encryptedNotif, 'string');
    assert.equal(typeof payload.notifIv, 'string');
    // Plaintext sensitive fields scrubbed
    assert.deepEqual(payload.toolInput, {});
    assert.equal(payload.description, 'Bash requires approval');
  });

  it('falls back to plaintext when config has no key', () => {
    const payload = buildEventPayload({
      base,
      sensitive: { toolInput: { command: 'ls' }, description: 'list' },
      config: null,
      fallbackDescription: 'should not appear',
    });
    assert.equal(payload.toolName, 'Bash');
    assert.deepEqual(payload.toolInput, { command: 'ls' });
    assert.equal(payload.description, 'list');
    assert.equal(payload.encryptedPayload, undefined);
    assert.equal(payload.iv, undefined);
  });
});
