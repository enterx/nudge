/**
 * Tests for CLI provider auto-detection.
 *
 * Run: node tests/provider.test.mjs
 */

import assert from 'node:assert/strict';
import { detectProvider } from '../scripts/lib/constants.mjs';

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    errors.push({ name, error: err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function provider(env = {}, parentCommands = []) {
  return detectProvider({ env, parentCommands });
}

console.log('\nProvider detection tests\n');

await test('NUDGE_PROVIDER override wins', async () => {
  assert.equal(
    provider({ NUDGE_PROVIDER: 'custom-agent', GITHUB_ACTIONS: 'true' }),
    'custom-agent',
  );
});

await test('CI environments are detected', async () => {
  assert.equal(provider({ GITHUB_ACTIONS: 'true', CURSOR_TRACE_ID: 'abc' }), 'github-actions');
  assert.equal(provider({ GITLAB_CI: 'true' }), 'gitlab-ci');
  assert.equal(provider({ CIRCLECI: 'true' }), 'circleci');
  assert.equal(provider({ CI: 'true' }), 'ci');
});

await test('ambient editor and agent env vars do not mark manual CLI runs', async () => {
  assert.equal(provider({ CURSOR_TRACE_ID: 'abc' }), undefined);
  assert.equal(provider({ WINDSURF_USER: 'ray' }), undefined);
  assert.equal(provider({ CLAUDE_CODE_SSE_PORT: '12345' }), undefined);
  assert.equal(provider({ CODEX_SANDBOX: 'workspace-write' }), undefined);
});

await test('provider can be explicit for editor integrations', async () => {
  assert.equal(provider({ NUDGE_PROVIDER: 'cursor', CURSOR_TRACE_ID: 'abc' }), 'cursor');
  assert.equal(provider({ NUDGE_PROVIDER: 'windsurf', WINDSURF_USER: 'ray' }), 'windsurf');
});

await test('direct AI CLI parent process commands are detected', async () => {
  assert.equal(provider({}, ['/opt/homebrew/bin/codex']), 'codex');
  assert.equal(provider({}, ['/opt/homebrew/bin/claude']), 'claude-code');
});

await test('shell-launched commands are treated as manual terminal runs', async () => {
  assert.equal(provider({}, ['/bin/zsh', '/Applications/Cursor.app/Contents/MacOS/Cursor']), undefined);
  assert.equal(provider({}, ['/bin/bash', '/opt/homebrew/bin/codex']), undefined);
  assert.equal(provider({}, ['/usr/local/bin/fish', '/opt/homebrew/bin/claude']), undefined);
});

await test('unknown provider returns undefined', async () => {
  assert.equal(provider({}, ['/bin/zsh', '/Applications/Terminal.app/Contents/MacOS/Terminal']), undefined);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
