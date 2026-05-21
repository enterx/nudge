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

// --- Pending-file test fixture ----------------------------------------------
//
// Most `nudge cancel` tests want an isolated `~/.nudge` with one or more
// pending-*.json fixtures. This helper creates a tempdir HOME, populates it,
// and returns the path so the caller can set `HOME` in the child env.
// `apiUrl` defaults to an unreachable address — `postCancel` silently swallows
// the resulting network error, which is what we want here (we only care that
// the local pending file gets resolved/removed).

import { mkdirSync } from 'node:fs';

function setupPendingHome(items) {
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  const nudgeDir = join(homeDir, '.nudge');
  mkdirSync(nudgeDir, { mode: 0o700 });
  for (const item of items) {
    const filename = `pending-${item.sessionId}-${item.eventId}.json`;
    writeFileSync(join(nudgeDir, filename), JSON.stringify({
      apiUrl: 'http://127.0.0.1:1',
      token: 'fake-token',
      pattern: 'approval',
      createdAt: Date.now(),
      ...item,
    }), { mode: 0o600 });
  }
  return { homeDir, nudgeDir };
}

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
  assert.match(stderr, /requires options.*--text.*--action/);
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

// --- run subcommand ---

await test('run without a command exits 2', async () => {
  const { code, stderr } = await runCli(['run']);
  assert.equal(code, 2);
  assert.match(stderr, /run requires a command/);
});

await test('run --on with invalid value exits 2', async () => {
  const { code, stderr } = await runCli(['run', '--on', 'maybe', '--', '/bin/sh', '-c', 'exit 0']);
  assert.equal(code, 2);
  assert.match(stderr, /--on must be one of/);
});

await test('run --tail with non-integer exits 2', async () => {
  const { code, stderr } = await runCli(['run', '--tail', '1.5', '--', '/bin/sh', '-c', 'exit 0']);
  assert.equal(code, 2);
  assert.match(stderr, /--tail must be a non-negative integer/);
});

await test('run propagates child exit code (success path, notify skipped when unpaired)', async () => {
  const { code, stderr } = await runCli(['run', '--on', 'success', '--', '/bin/sh', '-c', 'exit 0'], ENV_UNPAIRED);
  // Child exited 0; unpaired notify is best-effort and skipped.
  assert.equal(code, 0);
  // No exit code other than 0 should appear; stderr may carry the
  // "notification skipped" line but the child's exit is what matters.
  assert.match(stderr, /notification skipped|^$/);
});

await test('run propagates child exit code (failure path)', async () => {
  const { code } = await runCli(['run', '--on', 'fail', '--', '/bin/sh', '-c', 'exit 1'], ENV_UNPAIRED);
  // /usr/bin/false exits 1. Unpaired notify is skipped, child's exit propagates.
  assert.equal(code, 1);
});

await test('run --on success skips notify when child fails', async () => {
  const { code, stderr } = await runCli(['run', '--on', 'success', '--', '/bin/sh', '-c', 'exit 1'], ENV_UNPAIRED);
  assert.equal(code, 1);
  // We didn't try to notify, so the "notification skipped" warning should
  // be absent.
  assert.doesNotMatch(stderr, /notification skipped/);
});

// --- attachments (--image / --file) ---

await test('--image with missing file exits 2 with helpful message', async () => {
  const { code, stderr } = await runCli(
    ['approve', 'deploy', '--image', '/no/such/file.png'],
  );
  assert.equal(code, 2);
  assert.match(stderr, /attachment.*cannot read/);
});

await test('--file with missing path exits 2', async () => {
  const { code, stderr } = await runCli(
    ['notify', 'Build', 'failed', '--file', '/no/such/file.log'],
  );
  assert.equal(code, 2);
  assert.match(stderr, /attachment.*cannot read/);
});

await test('--image with oversize file exits 2 with limit message', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nudge-att-cli-'));
  try {
    const big = join(tmp, 'huge.png');
    writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 'x'));
    const { code, stderr } = await runCli(
      ['approve', 'big image test', '--image', big],
    );
    assert.equal(code, 2);
    assert.match(stderr, /exceeds the .*MB inline limit/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await test('--image with a small file is accepted past parser', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nudge-att-cli-'));
  try {
    const small = join(tmp, 'tiny.png');
    // Valid 1x1 PNG header bytes are enough to be a "real" small file.
    writeFileSync(small, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { code, stderr } = await runCli(
      ['approve', 'small image', '--image', small],
      ENV_UNPAIRED,
    );
    // Parser accepted the attachment; we exit at the unpaired stage.
    assert.equal(code, 3);
    assert.match(stderr, /not configured|re-pair|not paired/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- --ttl client-side timeout ---

await test('--ttl with non-positive number exits 2', async () => {
  const { code, stderr } = await runCli(['ask', 'q?', '--text', '--ttl', '0']);
  assert.equal(code, 2);
  assert.match(stderr, /--ttl must be a positive number/);
});

await test('--ttl with non-numeric value exits 2', async () => {
  const { code, stderr } = await runCli(['ask', 'q?', '--text', '--ttl', 'abc']);
  assert.equal(code, 2);
  assert.match(stderr, /--ttl must be a positive number/);
});

await test('--ttl accepts a positive integer (parser past validation)', async () => {
  // Unpaired path — proves --ttl was accepted at parse time.
  const { code, stderr } = await runCli(
    ['ask', 'q?', '--text', '--ttl', '30'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('approve --ttl accepted', async () => {
  const { code, stderr } = await runCli(
    ['approve', 'Deploy?', '--ttl', '60'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

// --- richer ask: --text / --action / structured context ---

await test('ask --text alone is enough (no -o required)', async () => {
  // Unpaired → exits 3 from handler. If parser still rejected, we'd see exit 2.
  const { code, stderr } = await runCli(
    ['ask', 'What should we name this?', '--text'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('ask --action alone is enough (no -o required)', async () => {
  const { code, stderr } = await runCli(
    ['ask', 'q?', '--action', 'verify:Run /verify'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('ask --action with bad spec exits 2', async () => {
  const { code, stderr } = await runCli(['ask', 'q?', '--action', 'novalue']);
  assert.equal(code, 2);
  assert.match(stderr, /value:label/i);
});

await test('ask with single -o still rejected (must be 2-4)', async () => {
  const { code, stderr } = await runCli(['ask', 'q?', '-o', 'a:A']);
  assert.equal(code, 2);
  assert.match(stderr, /at least 2 options/);
});

await test('ask -o + --action coexist (no required option-count error)', async () => {
  const { code, stderr } = await runCli(
    ['ask', 'q?', '-o', 'yes:Yes', '-o', 'no:No', '--action', 'diff:"Show diff"'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('approve accepts --action', async () => {
  const { code, stderr } = await runCli(
    ['approve', 'Deploy?', '--action', 'verify:Run /verify first'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
});

await test('--exit-code non-numeric exits 2', async () => {
  const { code, stderr } = await runCli(
    ['notify', 'Build', 'done', '--exit-code', 'abc'],
  );
  assert.equal(code, 2);
  assert.match(stderr, /--exit-code must be a number/);
});

await test('--diff with missing file exits 2 with helpful message', async () => {
  const { code, stderr } = await runCli(
    ['ask', 'q?', '--text', '--diff', '/does/not/exist.diff'],
  );
  assert.equal(code, 2);
  assert.match(stderr, /--diff: cannot read/);
});

await test('--files comma-split, --tool-name, --exit-code reach the handler (validated past parse)', async () => {
  // Combining all structured flags. Parsing should succeed; we exit at the
  // not-paired stage. Failure earlier in parse would surface here.
  const { code, stderr } = await runCli(
    ['notify', 'Build', 'failed',
     '--files', 'src/a.go,src/b.go',
     '--exit-code', '2',
     '--tool-name', 'go test'],
    ENV_UNPAIRED,
  );
  assert.equal(code, 3);
  assert.match(stderr, /not configured|re-pair|not paired/i);
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
  const { homeDir, nudgeDir } = setupPendingHome([
    { eventId: 'evt-XYZ', sessionId: 'sess-A', sessionName: 'Deploy v1.2', toolName: 'Bash' },
  ]);
  const pendingPath = join(nudgeDir, 'pending-sess-A-evt-XYZ.json');
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
  const { homeDir } = setupPendingHome(
    ['a', 'b', 'c'].map((s) => ({
      eventId: `evt-${s}`, sessionId: `sess-${s}`, createdAt: Date.now() + s.charCodeAt(0),
    })),
  );
  try {
    const { code, stdout } = await runCli(['cancel', '--all', '--json'], { HOME: homeDir });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.cancelled, 3);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel --all removes pre-1.2 files whose JSON body lacks sessionId', async () => {
  // Regression: pending files written before v1.2 (Claude Code hook adapter
  // pre-PR-15) only have sessionId in the filename, not the body. Firebase
  // eventIds start with `-`, so the filename-prefix fallback's last-dash
  // heuristic mis-derives the sessionId, and `clearPending(sessionId, eventId)`
  // would target a wrong path. cmdCancel must delete the file directly.
  const homeDir = mkdtempSync(join(tmpdir(), 'nudge-cancel-test-'));
  const nudgeDir = join(homeDir, '.nudge');
  mkdirSync(nudgeDir, { mode: 0o700 });
  const sessionPart = 'sess-uuid-with-dashes';
  const eventId = '-OrMvXPU_kaP4J9h2mWp';  // Firebase-style: leading dash
  const filename = `pending-${sessionPart}-${eventId}.json`;
  const filePath = join(nudgeDir, filename);
  writeFileSync(filePath, JSON.stringify({
    eventId,
    // NOTE: deliberately no `sessionId` field — pre-1.2 layout.
    apiUrl: 'http://127.0.0.1:1',
    token: 'fake',
    pattern: 'approval',
    createdAt: Date.now(),
  }), { mode: 0o600 });

  try {
    const { code } = await runCli(['cancel', '--all', '--json'], { HOME: homeDir });
    assert.equal(code, 0);
    assert.equal(existsSync(filePath), false,
      'pre-1.2 pending file should be deleted by cancel --all');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

await test('cancel --last picks the newest by createdAt', async () => {
  const { homeDir, nudgeDir } = setupPendingHome([
    { eventId: 'evt-old', sessionId: 's', createdAt: 1 },
    { eventId: 'evt-new', sessionId: 's', createdAt: 9999999 },
  ]);
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
  assert.match(parsed.error.message, /requires options.*--text.*--action/);
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
