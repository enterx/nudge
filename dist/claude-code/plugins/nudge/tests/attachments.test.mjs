/**
 * Tests for core/lib/attachments.mjs
 *
 * Covers mime detection from extension, size enforcement, hashing, and
 * base64 encoding. File I/O is real — we write small fixtures into a
 * tmp dir and clean up.
 *
 * Run: node tests/attachments.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAttachment, mimeFromPath, MAX_ATTACHMENT_BYTES } from '../scripts/lib/attachments.mjs';

describe('mimeFromPath', () => {
  it('maps common extensions case-insensitively', () => {
    assert.equal(mimeFromPath('/tmp/foo.png'), 'image/png');
    assert.equal(mimeFromPath('/tmp/foo.PNG'), 'image/png');
    assert.equal(mimeFromPath('foo.jpg'), 'image/jpeg');
    assert.equal(mimeFromPath('foo.jpeg'), 'image/jpeg');
    assert.equal(mimeFromPath('foo.pdf'), 'application/pdf');
    assert.equal(mimeFromPath('foo.txt'), 'text/plain');
    assert.equal(mimeFromPath('foo.diff'), 'text/x-diff');
    assert.equal(mimeFromPath('foo.patch'), 'text/x-diff');
    assert.equal(mimeFromPath('foo.json'), 'application/json');
    assert.equal(mimeFromPath('foo.md'), 'text/markdown');
  });

  it('falls back to octet-stream for unknown and no-extension paths', () => {
    assert.equal(mimeFromPath('foo.unknown'), 'application/octet-stream');
    assert.equal(mimeFromPath('Makefile'), 'application/octet-stream');
  });
});

describe('loadAttachment', () => {
  it('reads a small file and returns the expected shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-att-'));
    try {
      const path = join(dir, 'note.txt');
      writeFileSync(path, 'hello world');
      const att = loadAttachment(path);
      assert.equal(att.filename, 'note.txt');
      assert.equal(att.mime, 'text/plain');
      assert.equal(att.sizeBytes, 11);
      assert.equal(att.sha256.length, 64);
      // 'hello world' base64
      assert.equal(att.dataBase64, 'aGVsbG8gd29ybGQ=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when the file does not exist', () => {
    assert.throws(
      () => loadAttachment('/no/such/file/here.png'),
      /attachment: cannot read .* no such file|ENOENT/i,
    );
  });

  it('rejects directories with a clear message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-att-'));
    try {
      const sub = join(dir, 'subdir');
      mkdirSync(sub);
      assert.throws(
        () => loadAttachment(sub),
        /is not a regular file/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces the 2MB inline limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-att-'));
    try {
      const path = join(dir, 'big.bin');
      // 3MB exceeds the default 2MB limit.
      writeFileSync(path, Buffer.alloc(3 * 1024 * 1024, 'x'));
      assert.throws(
        () => loadAttachment(path),
        /exceeds the .*MB inline limit/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects a custom maxBytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-att-'));
    try {
      const path = join(dir, 'mid.bin');
      writeFileSync(path, Buffer.alloc(100, 'a'));
      // With a 50-byte limit, this should fail.
      assert.throws(
        () => loadAttachment(path, { maxBytes: 50 }),
        /exceeds the .*MB inline limit/,
      );
      // With a 100-byte limit (exactly the size), this succeeds.
      const att = loadAttachment(path, { maxBytes: 100 });
      assert.equal(att.sizeBytes, 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports MAX_ATTACHMENT_BYTES at 2MB', () => {
    assert.equal(MAX_ATTACHMENT_BYTES, 2 * 1024 * 1024);
  });
});
