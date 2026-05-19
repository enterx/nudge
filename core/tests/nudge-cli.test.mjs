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

await test('notify without title exits 2', async () => {
  const { code, stderr } = await runCli(['notify']);
  assert.equal(code, 2);
  assert.match(stderr, /notify requires --title/);
});

await test('notify without body exits 2', async () => {
  const { code, stderr } = await runCli(['notify', '--title', 'x']);
  assert.equal(code, 2);
  assert.match(stderr, /notify requires --body/);
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

await test('approve with --input invalid JSON exits 2', async () => {
  const { code, stderr } = await runCli(['approve', 'deploy', '--input', '{not json']);
  assert.equal(code, 2);
  assert.match(stderr, /--input must be valid JSON/);
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
