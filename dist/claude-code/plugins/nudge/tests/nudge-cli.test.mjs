/**
 * Tests for nudge-cli.mjs
 *
 * Spawns the CLI as a subprocess and verifies argv parsing, exit codes,
 * and output formatting. Network paths are not exercised — those go
 * through the same handlers.mjs covered by the MCP server tests.
 *
 * Run: node tests/nudge-cli.test.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'nudge-cli.mjs');

if (!existsSync(CLI_PATH)) {
  console.log('\nNudge CLI tests — skipped (nudge-cli.mjs not bundled here)\n');
  process.exit(0);
}

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

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Use a never-existing config path so handlers always see "not paired"
const NO_CONFIG_PATH = join(tmpdir(), `nudge-cli-test-${process.pid}-no-config`);
const ENV_UNPAIRED = { NUDGE_CONFIG_PATH: NO_CONFIG_PATH };

console.log('\nNudge CLI tests\n');

await test('--help prints usage and exits 0', async () => {
  const { code, stdout } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:\s+nudge <subcommand>/);
  assert.match(stdout, /pair/);
  assert.match(stdout, /approve/);
});

await test('no args prints help and exits 0', async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 0);
  assert.match(stdout, /Usage:\s+nudge <subcommand>/);
});

await test('--version prints SERVER_VERSION', async () => {
  const { code, stdout } = await runCli(['--version']);
  assert.equal(code, 0);
  assert.match(stdout, /^nudge \d+\.\d+\.\d+/);
});

await test('unknown subcommand exits 2 with usage hint', async () => {
  const { code, stderr } = await runCli(['bogus']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown subcommand: bogus/);
  assert.match(stderr, /--help/);
});

await test('approve without description exits 2', async () => {
  const { code, stderr } = await runCli(['approve']);
  assert.equal(code, 2);
  assert.match(stderr, /approve requires a description/);
});

await test('ask without options exits 2', async () => {
  const { code, stderr } = await runCli(['ask', 'test?']);
  assert.equal(code, 2);
  assert.match(stderr, /at least 2 options/);
});

await test('ask without question exits 2', async () => {
  const { code, stderr } = await runCli(['ask', '-o', 'a:A', '-o', 'b:B']);
  assert.equal(code, 2);
  assert.match(stderr, /ask requires a question/);
});

await test('notify without body exits 2', async () => {
  const { code, stderr } = await runCli(['notify']);
  assert.equal(code, 2);
  assert.match(stderr, /notify requires a body/);
});

await test('notify with title flag but no body exits 2', async () => {
  const { code, stderr } = await runCli(['notify', '--title', 'x']);
  assert.equal(code, 2);
  assert.match(stderr, /notify requires a body/);
});

await test('notify accepts positional body', async () => {
  const { code, stderr } = await runCli(['notify', 'Hello'], ENV_UNPAIRED);
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('notify accepts positional title and body', async () => {
  const { code, stderr } = await runCli(['notify', 'Build', 'deploy succeeded'], ENV_UNPAIRED);
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('notify allows positional body with level flag', async () => {
  const { code, stderr } = await runCli(['notify', 'Hello', '--level', 'success'], ENV_UNPAIRED);
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('mode without target exits 2', async () => {
  const { code, stderr } = await runCli(['mode']);
  assert.equal(code, 2);
  assert.match(stderr, /mode requires a target/);
});

await test('mode with invalid target exits 2', async () => {
  const { code, stderr } = await runCli(['mode', 'middle']);
  assert.equal(code, 2);
  assert.match(stderr, /must be "nudge" or "terminal"/);
});

await test('mode prints deprecation warning before delegating to status', async () => {
  const { code, stderr } = await runCli(['mode', 'nudge'], ENV_UNPAIRED);
  // unpaired → exits 3 from cmdStatus
  assert.equal(code, 3);
  assert.match(stderr, /`nudge mode` is deprecated/);
  assert.match(stderr, /status --mode/);
});

await test('mode help shows deprecation notice', async () => {
  const { code, stdout } = await runCli(['mode', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /DEPRECATED/);
});

// --- cancel ---

await test('cancel without selector exits 2', async () => {
  const { code, stderr } = await runCli(['cancel']);
  assert.equal(code, 2);
  assert.match(stderr, /requires exactly one selector/);
});

await test('cancel with two selectors exits 2', async () => {
  const { code, stderr } = await runCli(['cancel', '--last', '--all']);
  assert.equal(code, 2);
  assert.match(stderr, /mutually exclusive/);
});

await test('cancel --all with empty pending dir exits 0 (no-op)', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  try {
    const { code, stdout } = await runCli(['cancel', '--all'], { HOME: homeDir });
    assert.equal(code, 0);
    assert.match(stdout, /No pending events/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel --last with empty pending dir exits 0', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  try {
    const { code } = await runCli(['cancel', '--last'], { HOME: homeDir });
    assert.equal(code, 0);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel <unknown-id> exits 5 with not-found error', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  try {
    const { code, stderr } = await runCli(['cancel', 'evt-missing'], { HOME: homeDir });
    assert.equal(code, 5);
    assert.match(stderr, /No pending event found.*evt-missing/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel --session <unknown> exits 5', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  try {
    const { code, stderr } = await runCli(['cancel', '--session', 'No-Such'], { HOME: homeDir });
    assert.equal(code, 5);
    assert.match(stderr, /No pending events found for session "No-Such"/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel <event-id> resolves a real pending file, removes it, exits 0', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  const nudgeDir = join(homeDir, '.nudge');
  // Mirror the layout pending-files.mjs uses.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(nudgeDir, { mode: 0o700 });
  const pendingPath = join(nudgeDir, 'pending-sess-A-evt-XYZ.json');
  writeFileSync(pendingPath, JSON.stringify({
    eventId: 'evt-XYZ',
    sessionId: 'sess-A',
    sessionName: 'Deploy v1.2',
    apiUrl: 'http://127.0.0.1:1',  // unreachable — postCancel swallows error
    token: 'fake-token',
    pattern: 'approval',
    toolName: 'Bash',
    createdAt: Date.now(),
  }), { mode: 0o600 });

  try {
    const { code, stdout } = await runCli(['cancel', 'evt-XYZ', '--json'], { HOME: homeDir });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.cancelled, 1);
    assert.equal(parsed.events[0].eventId, 'evt-XYZ');
    assert.equal(parsed.events[0].sessionName, 'Deploy v1.2');
    assert.equal(existsSync(pendingPath), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel --all removes every pending file', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  const nudgeDir = join(homeDir, '.nudge');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(nudgeDir, { mode: 0o700 });
  for (const evt of ['a', 'b', 'c']) {
    writeFileSync(join(nudgeDir, `pending-sess-${evt}-evt-${evt}.json`), JSON.stringify({
      eventId: `evt-${evt}`,
      sessionId: `sess-${evt}`,
      apiUrl: 'http://127.0.0.1:1',
      token: 't',
      pattern: 'approval',
      createdAt: Date.now() + evt.charCodeAt(0),
    }), { mode: 0o600 });
  }

  try {
    const { code, stdout } = await runCli(['cancel', '--all', '--json'], { HOME: homeDir });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.cancelled, 3);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel --last picks the newest by createdAt', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  const nudgeDir = join(homeDir, '.nudge');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(nudgeDir, { mode: 0o700 });
  writeFileSync(join(nudgeDir, 'pending-s-evt-old.json'), JSON.stringify({
    eventId: 'evt-old', sessionId: 's', apiUrl: 'http://127.0.0.1:1', token: 't',
    pattern: 'approval', createdAt: 1,
  }), { mode: 0o600 });
  writeFileSync(join(nudgeDir, 'pending-s-evt-new.json'), JSON.stringify({
    eventId: 'evt-new', sessionId: 's', apiUrl: 'http://127.0.0.1:1', token: 't',
    pattern: 'approval', createdAt: 9999999,
  }), { mode: 0o600 });

  try {
    const { code, stdout } = await runCli(['cancel', '--last', '--json'], { HOME: homeDir });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.cancelled, 1);
    assert.equal(parsed.events[0].eventId, 'evt-new');
    // The older one should still be on disk
    assert.equal(existsSync(join(nudgeDir, 'pending-s-evt-old.json')), true);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('approve ignores legacy hidden flags with a warning', async () => {
  const { code, stderr } = await runCli(
    ['approve', 'deploy', '--input', '{"x":1}', '--tool', 'Bash'],
    ENV_UNPAIRED,
  );
  // unpaired → exits 3, but the warnings should appear on stderr
  assert.equal(code, 3);
  assert.match(stderr, /--input.*no longer supported/);
  assert.match(stderr, /--tool.*no longer supported/);
});

await test('status with no config exits 3 (not paired)', async () => {
  const { code, stdout } = await runCli(['status'], ENV_UNPAIRED);
  assert.equal(code, 3);
  assert.match(stdout, /Not paired/);
});

await test('status --json with no config emits JSON and exits 3', async () => {
  const { code, stdout } = await runCli(['status', '--json'], ENV_UNPAIRED);
  assert.equal(code, 3);
  const data = JSON.parse(stdout.trim());
  assert.equal(data.paired, false);
  assert.match(data.message, /nudge pair/);
});

// --- JSON envelope v2 (opt-in via NUDGE_JSON_VERSION=2) ---

await test('v2 envelope: status --json wraps payload with ok/command/data', async () => {
  const { code, stdout } = await runCli(
    ['status', '--json'],
    { ...ENV_UNPAIRED, NUDGE_JSON_VERSION: '2' },
  );
  assert.equal(code, 3);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.data.paired, false);
  assert.match(parsed.data.message, /nudge pair/);
});

await test('v2 envelope: ask --json unpaired emits ok:false error envelope on stdout', async () => {
  const { code, stdout } = await runCli(
    ['ask', 'q?', '-o', 'a:A', '-o', 'b:B', '--json'],
    { ...ENV_UNPAIRED, NUDGE_JSON_VERSION: '2' },
  );
  assert.equal(code, 3);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.command, 'ask');
  assert.equal(parsed.error.code, 'NOT_PAIRED');
  assert.match(parsed.error.message, /not configured|re-pair|not paired/i);
});

await test('v2 envelope: usage error on --json emits ok:false USAGE on stdout', async () => {
  const { code, stdout } = await runCli(
    ['ask', 'q?', '--json'],
    { NUDGE_JSON_VERSION: '2' },
  );
  assert.equal(code, 2);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'USAGE');
  assert.match(parsed.error.message, /at least 2 options/);
});

await test('v2 envelope: default mode (no env) still emits v1 shape', async () => {
  const { code, stdout } = await runCli(['status', '--json'], ENV_UNPAIRED);
  assert.equal(code, 3);
  const parsed = JSON.parse(stdout.trim());
  // v1: no top-level `ok` / `command` keys
  assert.equal(parsed.ok, undefined);
  assert.equal(parsed.command, undefined);
  assert.equal(parsed.paired, false);
});

await test('approve with no config exits 3 (not paired)', async () => {
  const { code, stderr } = await runCli(['approve', 'deploy?'], ENV_UNPAIRED);
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('ask option spec without label exits 2', async () => {
  const { code, stderr } = await runCli(['ask', 'q?', '-o', 'novalue']);
  assert.equal(code, 2);
  assert.match(stderr, /value:label/i);
});

// Config-present but invalid token path:
// Make a config dir with a config file that has no token → expect exit 3.
const tmpDir = mkdtempSync(join(tmpdir(), 'nudge-cli-test-'));
const cfgPath = join(tmpDir, 'config');
writeFileSync(cfgPath, JSON.stringify({ apiUrl: 'https://localhost:1' }));

try {
  await test('approve with config-but-no-token surfaces auth error (exit 3)', async () => {
    const { code, stderr } = await runCli(
      ['approve', 'deploy?'],
      { NUDGE_CONFIG_PATH: cfgPath },
    );
    assert.equal(code, 3);
    assert.match(stderr, /authentication token|re-pair/i);
  });
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
