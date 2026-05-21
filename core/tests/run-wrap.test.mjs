/**
 * Tests for core/lib/run-wrap.mjs
 *
 * Spawn small `/bin/sh -c` snippets and assert the captured exit code,
 * duration, and tail summary. POSIX-only — fine for this repo.
 *
 * Run: node tests/run-wrap.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runWrappedCommand } from '../lib/run-wrap.mjs';

describe('runWrappedCommand', () => {
  it('captures exit code and stdout tail', async () => {
    const result = await runWrappedCommand('/bin/sh', ['-c', 'echo line1; echo line2; exit 7']);
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert.ok(result.tail.includes('line1'));
    assert.ok(result.tail.includes('line2'));
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
  });

  it('captures both stdout and stderr', async () => {
    const result = await runWrappedCommand('/bin/sh', [
      '-c', 'echo out-line; echo err-line >&2; exit 0',
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.tail.includes('out-line'));
    assert.ok(result.tail.includes('err-line'));
  });

  it('caps the tail to tailLines', async () => {
    const result = await runWrappedCommand('/bin/sh', [
      '-c', 'for i in 1 2 3 4 5; do echo "line$i"; done',
    ], { tailLines: 2 });
    assert.equal(result.tail.length, 2);
    assert.deepEqual(result.tail, ['line4', 'line5']);
  });

  it('returns an empty tail when tailLines is 0', async () => {
    const result = await runWrappedCommand('/bin/sh', ['-c', 'echo line1; exit 0'], { tailLines: 0 });
    assert.deepEqual(result.tail, []);
    assert.equal(result.exitCode, 0);
  });

  it('rejects when the child fails to spawn', async () => {
    await assert.rejects(
      () => runWrappedCommand('/no/such/binary/here', []),
      (err) => /ENOENT|spawn|no such file/i.test(err.message),
    );
  });

  it('preserves a trailing partial line that lacks a final newline', async () => {
    // `printf` writes "partial" with no trailing newline.
    const result = await runWrappedCommand('/bin/sh', ['-c', 'printf "partial"']);
    assert.equal(result.exitCode, 0);
    assert.ok(result.tail.includes('partial'));
  });
});
