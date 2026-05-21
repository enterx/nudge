/**
 * Tests for core/lib/pending-files.mjs
 *
 * The module touches the filesystem (~/.nudge/pending-*.json). We
 * monkey-patch `homedir` via the env-based shim used elsewhere is not
 * available here, so instead we exercise the pure functions and treat
 * the file-IO helpers as best-effort (they swallow errors).
 *
 * Run: node tests/pending-files.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  hashToolInput,
  pendingFilePath,
  writePending,
  clearPending,
  listPendingForSession,
} from '../lib/pending-files.mjs';

describe('hashToolInput', () => {
  it('returns empty string for falsy input', () => {
    assert.equal(hashToolInput(null), '');
    assert.equal(hashToolInput(undefined), '');
  });

  it('produces a stable 16-char hex prefix', () => {
    const h = hashToolInput({ command: 'ls -la' }, 'Bash');
    assert.equal(h.length, 16);
    assert.match(h, /^[a-f0-9]+$/);
    assert.equal(h, hashToolInput({ command: 'ls -la' }, 'Bash'));
  });

  it('strips answers/annotations for AskUserQuestion', () => {
    const base = { questions: [{ question: 'q?' }] };
    const withAnswers = { ...base, answers: { 'q?': 'yes' }, annotations: {} };
    assert.equal(
      hashToolInput(base, 'AskUserQuestion'),
      hashToolInput(withAnswers, 'AskUserQuestion'),
    );
  });

  it('does NOT strip answers for non-AskUserQuestion tools', () => {
    const base = { command: 'ls' };
    const withExtra = { command: 'ls', answers: { x: 1 } };
    assert.notEqual(
      hashToolInput(base, 'Bash'),
      hashToolInput(withExtra, 'Bash'),
    );
  });
});

describe('pendingFilePath', () => {
  it('builds a path under the home .nudge directory', () => {
    const p = pendingFilePath('sess-123', 'evt-abc');
    assert.equal(p, join(homedir(), '.nudge', 'pending-sess-123-evt-abc.json'));
  });
});

describe('write/clear/listPendingForSession (real filesystem)', () => {
  // Skip these tests if we can't write into ~/.nudge — CI sandboxes etc.
  let canWrite = false;
  const dir = join(homedir(), '.nudge');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const probe = join(dir, `.probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'x');
    rmSync(probe);
    canWrite = true;
  } catch { /* skip */ }

  const skip = !canWrite;
  const sessionId = `pf-test-${process.pid}`;
  const eventId = `evt-${Date.now()}`;

  it('round-trips a pending record', { skip }, () => {
    writePending(sessionId, eventId, {
      apiUrl: 'https://example.test',
      token: 'tok',
      pattern: 'approval',
      toolUseId: 'tu',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    const path = pendingFilePath(sessionId, eventId);
    assert.equal(existsSync(path), true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(parsed.eventId, eventId);
    assert.equal(parsed.apiUrl, 'https://example.test');
    assert.equal(parsed.token, 'tok');
    assert.equal(parsed.pattern, 'approval');
    assert.equal(parsed.toolUseId, 'tu');
    assert.equal(parsed.toolName, 'Bash');
    assert.equal(parsed.toolInputHash.length, 16);

    const listed = listPendingForSession(sessionId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].data.eventId, eventId);

    clearPending(sessionId, eventId);
    assert.equal(existsSync(path), false);
    assert.equal(listPendingForSession(sessionId).length, 0);
  });

  it('listPendingForSession returns [] when nothing matches', { skip }, () => {
    assert.deepEqual(listPendingForSession(`${sessionId}-no-such`), []);
  });

  it('writePending is best-effort (no throw on bad input)', () => {
    // Best-effort write to nowhere (huge eventId with NUL would normally fail).
    // The function swallows errors per its contract.
    assert.doesNotThrow(() =>
      writePending(sessionId, '\0bad', {
        apiUrl: 'x', token: 'x', pattern: 'x', toolUseId: 'x', toolName: 'x', toolInput: {},
      }),
    );
  });
});
