/**
 * Tests for terminal-scoped session ID derivation.
 *
 * Run: node tests/session-id.test.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const constantsPath = [
  join(__dirname, '..', 'lib', 'constants.mjs'),
  join(__dirname, '..', 'scripts', 'lib', 'constants.mjs'),
].find((path) => existsSync(path));
const CONSTANTS_URL = pathToFileURL(constantsPath).href;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function makeEnv(configDir, extra = {}) {
  const env = { ...process.env, ...extra, NUDGE_CONFIG_DIR: configDir };
  delete env.NUDGE_CONFIG_PATH;
  if (!('NUDGE_SESSION_ID' in extra)) delete env.NUDGE_SESSION_ID;
  if (!('TERM_SESSION_ID' in extra)) delete env.TERM_SESSION_ID;
  if (!('CLAUDE_CODE_SSE_PORT' in extra)) delete env.CLAUDE_CODE_SSE_PORT;
  return env;
}

function runGetSessionId(configDir, extra = {}, hostSessionId = '') {
  const script = `
    import { getSessionId, SESSION_ID_PATH } from ${JSON.stringify(CONSTANTS_URL)};
    const id = getSessionId(${JSON.stringify(hostSessionId)});
    process.stdout.write(JSON.stringify({ id, path: SESSION_ID_PATH }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: makeEnv(configDir, extra),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

console.log('\nSession ID tests\n');

await test('host-provided session id wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-session-test-'));
  try {
    const result = runGetSessionId(dir, {}, 'host-session-123');
    assert.equal(result.id, 'host-session-123');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('NUDGE_SESSION_ID overrides terminal-derived ids', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-session-test-'));
  try {
    const result = runGetSessionId(dir, {
      NUDGE_SESSION_ID: 'deploy-456',
      TERM_SESSION_ID: 'term-ignored',
    });
    assert.equal(result.id, 'deploy-456');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('existing parent-pid session file wins over TERM_SESSION_ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-session-test-'));
  try {
    writeFileSync(join(dir, `session_id.${process.pid}`), 'existing-session\n');
    const result = runGetSessionId(dir, { TERM_SESSION_ID: 'term-ignored' });
    assert.equal(result.id, 'existing-session');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('TERM_SESSION_ID groups commands by terminal session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-session-test-'));
  try {
    const first = runGetSessionId(dir, { TERM_SESSION_ID: 'A1B2C3' });
    const second = runGetSessionId(dir, { TERM_SESSION_ID: 'A1B2C3' });
    assert.equal(first.id, 'term-A1B2C3');
    assert.equal(second.id, first.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('plain CLI calls from the same parent shell reuse a persisted session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-session-test-'));
  try {
    const first = runGetSessionId(dir);
    const second = runGetSessionId(dir);
    assert.match(first.id, UUID_PATTERN);
    assert.equal(second.id, first.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('CLAUDE_CODE_SSE_PORT does not group separate terminal shells', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-session-test-'));
  try {
    const script =
      `import { getSessionId, SESSION_ID_PATH } from ${JSON.stringify(CONSTANTS_URL)};` +
      'process.stdout.write(JSON.stringify({ id: getSessionId(), path: SESSION_ID_PATH }));';
    const runViaShell = () => {
      const result = spawnSync('/bin/sh', ['-c', `${process.execPath} --input-type=module -e ${JSON.stringify(script)}; :`], {
        env: makeEnv(dir, { CLAUDE_CODE_SSE_PORT: '57080' }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };

    const first = runViaShell();
    const second = runViaShell();
    assert.match(first.id, UUID_PATTERN);
    assert.match(second.id, UUID_PATTERN);
    assert.notEqual(first.path, second.path);
    assert.notEqual(first.id, second.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
