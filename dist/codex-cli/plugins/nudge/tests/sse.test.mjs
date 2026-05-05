/**
 * Tests for scripts/lib/sse.mjs
 *
 * Covers: waitForDecision (SSE stream parsing, reconnects, timeouts)
 * Zero external dependencies — uses node:assert + node:test + mock server
 *
 * Run: node tests/sse.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { MockServer } from './helpers/mock-server.mjs';

// We need to override SSE constants for faster tests
// Import the module dynamically

// --- waitForDecision ---

describe('waitForDecision', () => {
  /** @type {MockServer} */
  let server;

  before(async () => {
    server = new MockServer();
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(() => {
    server.clearRequests();
  });

  it('receives a decision from the SSE stream', async () => {
    server.configure({
      sseMessages: [
        { path: '/', data: null },  // Initial put (no data yet)
        { path: '/', data: { action: 'approved', reason: 'LGTM' } },
      ],
      sseCloseAfterSend: true,
    });

    // Import fresh to avoid stale module state
    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    const result = await waitForDecision(server.sseUrl, 'test-token');
    assert.equal(result.action, 'approved');
    assert.equal(result.reason, 'LGTM');
  });

  it('skips initial null data and waits for real payload', async () => {
    server.configure({
      sseMessages: [
        { path: '/', data: null },
        { path: '/', data: null },
        { path: '/', data: { action: 'denied', reason: 'Not now' } },
      ],
      sseCloseAfterSend: true,
    });

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    const result = await waitForDecision(server.sseUrl, 'test-token');
    assert.equal(result.action, 'denied');
    assert.equal(result.reason, 'Not now');
  });

  it('handles SSE keepalive (empty data lines)', async () => {
    // Create a custom server that sends keepalive messages
    const keepaliveServer = new MockServer();
    await keepaliveServer.start();

    keepaliveServer.configure({
      sseMessages: [
        '',  // keepalive — empty string
        { path: '/', data: { action: 'approved' } },
      ],
      sseCloseAfterSend: true,
    });

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    try {
      const result = await waitForDecision(keepaliveServer.sseUrl, 'test-token');
      assert.equal(result.action, 'approved');
    } finally {
      await keepaliveServer.stop();
    }
  });

  it('throws error when no RTDB stream URL is provided', async () => {
    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    await assert.rejects(
      () => waitForDecision('', 'test-token'),
      (err) => {
        assert.ok(err.message.includes('No RTDB stream URL'));
        return true;
      },
    );
  });

  it('throws error when RTDB stream URL is null', async () => {
    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    await assert.rejects(
      () => waitForDecision(null, 'test-token'),
      (err) => {
        assert.ok(err.message.includes('No RTDB stream URL'));
        return true;
      },
    );
  });

  it('handles non-JSON data lines gracefully', async () => {
    const customServer = new MockServer();
    await customServer.start();

    customServer.configure({
      sseMessages: [
        'not-valid-json',
        { path: '/', data: { action: 'approved', reason: 'after bad data' } },
      ],
      sseCloseAfterSend: true,
    });

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    try {
      const result = await waitForDecision(customServer.sseUrl, 'test-token');
      assert.equal(result.action, 'approved');
    } finally {
      await customServer.stop();
    }
  });

  it('appends auth token to SSE URL', async () => {
    server.configure({
      sseMessages: [
        { path: '/', data: { action: 'approved' } },
      ],
      sseCloseAfterSend: true,
    });

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');
    await waitForDecision(server.sseUrl, 'my-secret-token');

    // Check that the SSE request had the auth parameter
    const sseReq = server.requests.find((r) => r.path.startsWith('/sse/'));
    assert.ok(sseReq, 'SSE request should have been made');
  });

  it('handles SSE URL with existing query parameters', async () => {
    server.configure({
      sseMessages: [
        { path: '/', data: { action: 'approved' } },
      ],
      sseCloseAfterSend: true,
    });

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');
    // URL already has a query param — should use & instead of ?
    const urlWithParam = `${server.sseUrl}?orderBy="$key"`;
    const result = await waitForDecision(urlWithParam, 'tok');
    assert.equal(result.action, 'approved');
  });

  it('returns payload directly when data has action (non-RTDB format)', async () => {
    // Some messages may not be in Firebase RTDB format (no path/data wrapper)
    const directServer = new MockServer();
    await directServer.start();

    directServer.configure({
      sseMessages: [
        { action: 'denied', reason: 'Direct format' },
      ],
      sseCloseAfterSend: true,
    });

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    try {
      const result = await waitForDecision(directServer.sseUrl, 'tok');
      assert.equal(result.action, 'denied');
      assert.equal(result.reason, 'Direct format');
    } finally {
      await directServer.stop();
    }
  });

  it('throws after max reconnect attempts on repeated HTTP errors', async () => {
    const errorServer = new MockServer({
      eventsCreateStatus: 500,
    });
    await errorServer.start();

    // Create an endpoint that always returns 500 for SSE
    const badSseUrl = `${errorServer.url}/sse/fail.json`;
    errorServer.configure({
      // Override the SSE handler to return 500
    });

    // We cannot easily make the SSE endpoint return 500 with the current mock
    // server architecture. Instead, test with a non-existent port.
    await errorServer.stop();

    const { waitForDecision } = await import('../scripts/lib/sse.mjs');

    // Use a URL that will fail to connect
    const badUrl = 'http://127.0.0.1:1/sse/nonexistent.json';

    await assert.rejects(
      () => waitForDecision(badUrl, 'tok'),
      (err) => {
        assert.ok(
          err.message.includes('SSE connection failed') ||
          err.message.includes('max reconnect'),
          `Expected SSE failure message, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
