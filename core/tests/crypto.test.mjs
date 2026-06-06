/**
 * crypto.test.mjs — key wrap/unwrap round-trip for pairing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateEncryptionKey,
  deriveWrappingKey,
  wrapKey,
  unwrapKey,
} from '../lib/crypto.mjs';

describe('wrapKey / unwrapKey', () => {
  it('round-trips an encryption key through the pairing-code wrapping key', () => {
    const code = 'ABCD-2345';
    const uid = 'mobile-uid-xyz';
    const key = generateEncryptionKey();

    const wrappingKey = deriveWrappingKey(code, uid);
    const { wrappedKey, wrappingIv } = wrapKey(key, wrappingKey);

    // A fresh derivation (as the other device would do) recovers the same key.
    const recovered = unwrapKey(wrappedKey, wrappingIv, deriveWrappingKey(code, uid));
    assert.equal(recovered, key);
  });

  it('normalizes the pairing code (hyphen / case) so both sides agree', () => {
    const uid = 'uid-1';
    const key = generateEncryptionKey();
    const { wrappedKey, wrappingIv } = wrapKey(key, deriveWrappingKey('ab12-cd34', uid));

    // Mobile entered the same code differently — must still unwrap.
    const recovered = unwrapKey(wrappedKey, wrappingIv, deriveWrappingKey('AB12CD34', uid));
    assert.equal(recovered, key);
  });

  it('fails to unwrap when the wrong UID is used as the PBKDF2 salt', () => {
    const code = 'ZZ99-YY88';
    const key = generateEncryptionKey();
    const { wrappedKey, wrappingIv } = wrapKey(key, deriveWrappingKey(code, 'correct-uid'));

    assert.throws(() =>
      unwrapKey(wrappedKey, wrappingIv, deriveWrappingKey(code, 'orphan-pairId')),
    );
  });
});
