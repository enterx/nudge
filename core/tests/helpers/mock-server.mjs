/**
 * mock-server.mjs — Local HTTP + SSE mock server for Nudge plugin tests
 *
 * Simulates the Nudge backend API endpoints:
 *   POST /eventsCreate
 *   POST /eventsRespond/:eventId/respond
 *   POST /eventsCancel
 *   POST /pairGenerate
 *   POST /pairVerify
 *   GET  /sse/:streamId (SSE stream)
 *   POST /v1/token (token refresh)
 *
 * Zero external dependencies — uses only node:http.
 */

import { createServer } from 'node:http';

/**
 * @typedef {object} MockServerOptions
 * @property {object} [eventsCreateResponse] - Response for POST /eventsCreate
 * @property {object} [pairGenerateResponse] - Response for POST /pairGenerate
 * @property {object} [pairVerifyResponse]   - Response for POST /pairVerify
 * @property {object} [tokenRefreshResponse] - Response for POST /v1/token
 * @property {number} [eventsCreateStatus]   - HTTP status for /eventsCreate (default 200)
 * @property {number} [tokenRefreshStatus]   - HTTP status for /v1/token (default 200)
 * @property {number} [responseDelayMs]      - Delay before responding (default 0)
 * @property {Array}  [sseMessages]          - SSE messages to send on stream connect
 * @property {number} [sseDelayMs]           - Delay between SSE messages (default 50)
 * @property {boolean} [sseCloseAfterSend]   - Close SSE stream after sending all messages
 */

export class MockServer {
  /**
   * @param {MockServerOptions} [options]
   */
  constructor(options = {}) {
    this.options = {
      eventsCreateResponse: {
        eventId: 'evt-test-001',
        rtdbStreamUrl: null, // Set dynamically after start
        deviceCount: 1,
      },
      pairGenerateResponse: {
        pairingCode: 'ABC123',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      },
      pairVerifyResponse: {
        status: 'verified',
        token: 'new-id-token',
        refreshToken: 'new-refresh-token',
      },
      tokenRefreshResponse: {
        id_token: 'refreshed-id-token',
        refresh_token: 'refreshed-refresh-token',
      },
      eventsCreateStatus: 200,
      tokenRefreshStatus: 200,
      responseDelayMs: 0,
      sseMessages: [],
      sseDelayMs: 50,
      sseCloseAfterSend: true,
      ...options,
    };

    /** @type {import('node:http').Server|null} */
    this._server = null;
    this._port = 0;

    /** Recorded requests for assertions */
    this.requests = [];

    /** Active SSE connections */
    this._sseConnections = new Set();
  }

  /** Base URL of the running server */
  get url() {
    return `http://127.0.0.1:${this._port}`;
  }

  /** SSE stream URL (uses the default stream ID) */
  get sseUrl() {
    return `${this.url}/sse/default-stream.json`;
  }

  /**
   * Start the server on a random port.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => this._handleRequest(req, res));
      this._server.listen(0, '127.0.0.1', () => {
        this._port = this._server.address().port;

        // Update the default eventsCreate response with the real SSE URL
        if (!this.options.eventsCreateResponse.rtdbStreamUrl) {
          this.options.eventsCreateResponse.rtdbStreamUrl = this.sseUrl;
        }

        resolve();
      });
      this._server.on('error', reject);
    });
  }

  /**
   * Stop the server and close all SSE connections.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      for (const conn of this._sseConnections) {
        conn.destroy();
      }
      this._sseConnections.clear();

      if (this._server) {
        this._server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Update options on the fly (e.g., change response data between tests).
   * @param {Partial<MockServerOptions>} updates
   */
  configure(updates) {
    Object.assign(this.options, updates);
  }

  /** Clear recorded requests */
  clearRequests() {
    this.requests = [];
  }

  /**
   * Send additional SSE messages to all active SSE connections.
   * @param {Array<object|string>} messages
   */
  async sendSSEMessages(messages) {
    for (const conn of this._sseConnections) {
      for (const msg of messages) {
        const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
        conn.write(`event: put\ndata: ${data}\n\n`);
      }
    }
  }

  // --- Internal ---

  async _handleRequest(req, res) {
    const body = await this._readBody(req);
    const url = new URL(req.url, `http://${req.headers.host}`);

    this.requests.push({
      method: req.method,
      path: url.pathname,
      headers: { ...req.headers },
      body,
    });

    // Apply delay if configured
    if (this.options.responseDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.responseDelayMs));
    }

    // Route
    if (req.method === 'POST' && url.pathname === '/eventsCreate') {
      return this._respondJSON(
        res,
        this.options.eventsCreateStatus,
        this.options.eventsCreateResponse,
      );
    }

    if (req.method === 'POST' && url.pathname.match(/\/eventsRespond\/.*\/respond/)) {
      return this._respondJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/eventsCancel') {
      return this._respondJSON(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/pairGenerate') {
      return this._respondJSON(res, 200, this.options.pairGenerateResponse);
    }

    if (req.method === 'POST' && url.pathname === '/pairVerify') {
      return this._respondJSON(res, 200, this.options.pairVerifyResponse);
    }

    // Token refresh endpoint (Google SecureToken API shape)
    if (req.method === 'POST' && url.pathname.startsWith('/v1/token')) {
      return this._respondJSON(
        res,
        this.options.tokenRefreshStatus,
        this.options.tokenRefreshResponse,
      );
    }

    // SSE stream
    if (req.method === 'GET' && url.pathname.startsWith('/sse/')) {
      return this._handleSSE(req, res);
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    this._sseConnections.add(res);
    req.on('close', () => this._sseConnections.delete(res));

    // Send configured messages with delays
    const messages = this.options.sseMessages;
    if (messages.length === 0 && this.options.sseCloseAfterSend) {
      // No messages — just keep connection open briefly then close
      setTimeout(() => {
        if (!res.destroyed) {
          res.end();
          this._sseConnections.delete(res);
        }
      }, 100);
      return;
    }

    let index = 0;
    const sendNext = () => {
      if (index >= messages.length) {
        if (this.options.sseCloseAfterSend) {
          setTimeout(() => {
            if (!res.destroyed) {
              res.end();
              this._sseConnections.delete(res);
            }
          }, 50);
        }
        return;
      }

      const msg = messages[index++];
      const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
      res.write(`event: put\ndata: ${data}\n\n`);

      if (index < messages.length) {
        setTimeout(sendNext, this.options.sseDelayMs);
      } else if (this.options.sseCloseAfterSend) {
        setTimeout(() => {
          if (!res.destroyed) {
            res.end();
            this._sseConnections.delete(res);
          }
        }, 50);
      }
    };

    // Small delay before first message to simulate real server
    setTimeout(sendNext, 10);
  }

  _respondJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(raw);
        }
      });
    });
  }
}
