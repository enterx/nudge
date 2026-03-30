/**
 * Tests for nudge-mcp-server.mjs
 *
 * Spawns the MCP server as a subprocess and sends JSON-RPC messages over stdio.
 * No test framework needed — uses Node.js assert.
 *
 * Run: node nudge-mcp-server.test.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'nudge-mcp-server.mjs');

// --- Helpers ---

function startServer() {
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return proc;
}

function sendAndReceive(proc, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for response to: ${JSON.stringify(message)}`));
    }, 5000);

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          clearTimeout(timeout);
          proc.stdout.removeListener('data', onData);
          resolve(parsed);
          return;
        } catch {
          // Not complete JSON yet
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(message) + '\n');
  });
}

function sendNotification(proc, message) {
  proc.stdin.write(JSON.stringify(message) + '\n');
}

// --- Tests ---

let passed = 0;
let failed = 0;
const errors = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    errors.push({ name, error: err });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
  }
}

console.log('\nMCP Server Tests\n');

// --- Test: initialize ---

await test('initialize returns correct protocol version and capabilities', async () => {
  const proc = startServer();
  try {
    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    assert.equal(resp.jsonrpc, '2.0');
    assert.equal(resp.id, 1);
    assert.equal(resp.result.protocolVersion, '2024-11-05');
    assert.deepEqual(resp.result.capabilities, { tools: {} });
    assert.equal(resp.result.serverInfo.name, 'nudge-mcp');
    assert.equal(resp.result.serverInfo.version, '1.1.0');
  } finally {
    proc.kill();
  }
});

// --- Test: tools/list ---

await test('tools/list returns all 3 nudge tools', async () => {
  const proc = startServer();
  try {
    // Initialize first
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    // Send initialized notification (no response expected)
    sendNotification(proc, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    // Wait a bit for notification to be processed
    await new Promise((r) => setTimeout(r, 50));

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    assert.equal(resp.id, 2);
    assert.equal(resp.result.tools.length, 3);

    const askTool = resp.result.tools.find((t) => t.name === 'nudge_ask_user');
    const approveTool = resp.result.tools.find((t) => t.name === 'nudge_approve');
    const notifyTool = resp.result.tools.find((t) => t.name === 'nudge_notify');
    assert.ok(askTool, 'nudge_ask_user tool should exist');
    assert.ok(approveTool, 'nudge_approve tool should exist');
    assert.ok(notifyTool, 'nudge_notify tool should exist');

    const schema = askTool.inputSchema;
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.question);
    assert.ok(schema.properties.options);
    assert.ok(schema.properties.multiSelect);
    assert.deepEqual(schema.required, ['question', 'options']);

    // Verify nudge_ask_user has context property
    assert.ok(schema.properties.context, 'nudge_ask_user should have context property');

    const approveSchema = approveTool.inputSchema;
    assert.ok(approveSchema.properties.description);
    assert.ok(approveSchema.properties.toolName);
    assert.ok(approveSchema.properties.context, 'nudge_approve should have context property');
    assert.ok(approveSchema.properties.toolInput, 'nudge_approve should have toolInput property');
    assert.ok(approveSchema.properties.cwd, 'nudge_approve should have cwd property');
    assert.deepEqual(approveSchema.required, ['description']);

    // Verify nudge_notify schema
    const notifySchema = notifyTool.inputSchema;
    assert.ok(notifySchema.properties.title, 'nudge_notify should have title property');
    assert.ok(notifySchema.properties.body, 'nudge_notify should have body property');
    assert.ok(notifySchema.properties.level, 'nudge_notify should have level property');
    assert.deepEqual(notifySchema.required, ['title', 'body']);
  } finally {
    proc.kill();
  }
});

// --- Test: tools/list schema details ---

await test('nudge_ask_user schema has correct option constraints', async () => {
  const proc = startServer();
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    const optionsSchema = resp.result.tools[0].inputSchema.properties.options;
    assert.equal(optionsSchema.type, 'array');
    assert.equal(optionsSchema.minItems, 2);
    assert.equal(optionsSchema.maxItems, 4);
    assert.deepEqual(optionsSchema.items.required, ['value', 'label']);
  } finally {
    proc.kill();
  }
});

// --- Test: unknown tool ---

await test('tools/call with unknown tool returns isError', async () => {
  const proc = startServer();
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'nonexistent_tool',
        arguments: {},
      },
    });

    assert.equal(resp.id, 3);
    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('Unknown tool'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_ask_user validation - missing question ---

await test('nudge_ask_user rejects missing question', async () => {
  const proc = startServer();
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'nudge_ask_user',
        arguments: {
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('question'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_ask_user validation - too few options ---

await test('nudge_ask_user rejects fewer than 2 options', async () => {
  const proc = startServer();
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'nudge_ask_user',
        arguments: {
          question: 'Pick one',
          options: [{ value: 'a', label: 'A' }],
        },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('2-4'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_ask_user validation - too many options ---

await test('nudge_ask_user rejects more than 4 options', async () => {
  const proc = startServer();
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'nudge_ask_user',
        arguments: {
          question: 'Pick one',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: 'c', label: 'C' },
            { value: 'd', label: 'D' },
            { value: 'e', label: 'E' },
          ],
        },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('2-4'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_ask_user validation - option missing value ---

await test('nudge_ask_user rejects option without value', async () => {
  const proc = startServer();
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'nudge_ask_user',
        arguments: {
          question: 'Pick one',
          options: [
            { value: 'a', label: 'A' },
            { label: 'B' },
          ],
        },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('value'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_ask_user - no config file ---

await test('nudge_ask_user returns error when not configured', async () => {
  // Use a non-existent config path to simulate unconfigured state
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config' },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'nudge_ask_user',
        arguments: {
          question: 'Which approach?',
          options: [
            { value: 'a', label: 'Approach A' },
            { value: 'b', label: 'Approach B' },
          ],
        },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('Nudge'));
    assert.ok(resp.result.content[0].text.includes('Fall back'));
  } finally {
    proc.kill();
  }
});

// --- Test: unknown method ---

await test('unknown method returns method not found error', async () => {
  const proc = startServer();
  try {
    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 99,
      method: 'nonexistent/method',
      params: {},
    });

    assert.equal(resp.id, 99);
    assert.equal(resp.error.code, -32601);
    assert.ok(resp.error.message.includes('Method not found'));
  } finally {
    proc.kill();
  }
});

// --- Test: ping ---

await test('ping returns empty result', async () => {
  const proc = startServer();
  try {
    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 100,
      method: 'ping',
    });

    assert.equal(resp.id, 100);
    assert.deepEqual(resp.result, {});
  } finally {
    proc.kill();
  }
});

// --- Test: invalid JSON ---

await test('invalid JSON returns parse error', async () => {
  const proc = startServer();
  try {
    const resp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
      proc.stdout.once('data', (chunk) => {
        clearTimeout(timeout);
        resolve(JSON.parse(chunk.toString().trim()));
      });
      proc.stdin.write('not valid json\n');
    });

    assert.equal(resp.error.code, -32700);
    assert.ok(resp.error.message.includes('Parse error'));
  } finally {
    proc.kill();
  }
});

// --- Test: stable SESSION_ID across calls ---

await test('SESSION_ID is stable across multiple tool calls in the same process', async () => {
  // We verify indirectly: start a server with a non-existent config,
  // call nudge_ask_user twice, both should fail with the same "not configured" error.
  // The key test is that both errors are returned (no crash from SESSION_ID).
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config' },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp1 = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'nudge_approve',
        arguments: { description: 'First call' },
      },
    });

    const resp2 = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'nudge_approve',
        arguments: { description: 'Second call' },
      },
    });

    // Both should return errors (not configured) without crashing
    assert.equal(resp1.id, 10);
    assert.equal(resp1.result.isError, true);
    assert.equal(resp2.id, 11);
    assert.equal(resp2.result.isError, true);
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_notify validation - missing title ---

await test('nudge_notify rejects missing title', async () => {
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config' },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'nudge_notify',
        arguments: { body: 'some body' },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('title'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_notify validation - missing body ---

await test('nudge_notify rejects missing body', async () => {
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config' },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'nudge_notify',
        arguments: { title: 'some title' },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('body'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_notify validation - invalid level ---

await test('nudge_notify rejects invalid level', async () => {
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config' },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'nudge_notify',
        arguments: { title: 'Test', body: 'Details', level: 'critical' },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('level'));
  } finally {
    proc.kill();
  }
});

// --- Test: nudge_notify - no config ---

await test('nudge_notify returns error when not configured', async () => {
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config' },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: {
        name: 'nudge_notify',
        arguments: { title: 'Build Complete', body: 'All tests passed' },
      },
    });

    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('Nudge'));
    assert.ok(resp.result.content[0].text.includes('Fall back'));
  } finally {
    proc.kill();
  }
});

// --- Test: NUDGE_PROVIDER env var ---

await test('NUDGE_PROVIDER env var is respected', async () => {
  // We cannot directly check the provider sent to the API without a mock server,
  // but we verify the server starts and accepts tool calls with a custom provider set.
  const proc = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NUDGE_CONFIG_PATH: '/tmp/nudge-test-nonexistent/config',
      NUDGE_PROVIDER: 'codex',
    },
  });
  try {
    await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });

    const resp = await sendAndReceive(proc, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'nudge_approve',
        arguments: { description: 'Test with codex provider' },
      },
    });

    // Should return error (not configured) but process should not crash
    assert.equal(resp.id, 12);
    assert.equal(resp.result.isError, true);
    assert.ok(resp.result.content[0].text.includes('Nudge'));
  } finally {
    proc.kill();
  }
});

// --- Summary ---

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log('Failed tests:');
  for (const { name, error } of errors) {
    console.log(`  - ${name}: ${error.message}`);
  }
  process.exit(1);
}
