/**
 * Tests for scripts/lib/config.mjs
 *
 * Covers: readConfig, getApiUrl
 * Zero external dependencies — uses node:assert + node:test
 *
 * Run: node tests/config.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set up isolated config path BEFORE importing config.mjs
const TEST_DIR = join(tmpdir(), `nudge-config-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, 'config');
process.env.NUDGE_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.NUDGE_CONFIG_DIR = TEST_DIR;

// Clear NUDGE_API_URL to test default fallback
const savedApiUrl = process.env.NUDGE_API_URL;
delete process.env.NUDGE_API_URL;

// Dynamic import after env setup
const { readConfig, getApiUrl } = await import('../lib/config.mjs');

// --- Setup & teardown ---

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  // Restore env
  if (savedApiUrl !== undefined) {
    process.env.NUDGE_API_URL = savedApiUrl;
  }
});

beforeEach(() => {
  // Remove config file before each test
  if (existsSync(TEST_CONFIG_PATH)) {
    unlinkSync(TEST_CONFIG_PATH);
  }
});

// --- readConfig ---

describe('readConfig', () => {
  it('returns parsed object for valid JSON config', () => {
    const config = { token: 'abc123', apiUrl: 'https://example.com' };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });

    const result = readConfig();
    assert.deepEqual(result, config);
  });

  it('returns null when config file does not exist', () => {
    // Config file was removed in beforeEach
    const result = readConfig();
    assert.equal(result, null);
  });

  it('returns null for malformed JSON', () => {
    writeFileSync(TEST_CONFIG_PATH, '{invalid json!!!', { mode: 0o600 });

    const result = readConfig();
    assert.equal(result, null);
  });

  it('returns null for empty file', () => {
    writeFileSync(TEST_CONFIG_PATH, '', { mode: 0o600 });

    const result = readConfig();
    assert.equal(result, null);
  });

  it('reads config with nested objects', () => {
    const config = {
      token: 'tok',
      nested: { a: 1, b: [2, 3] },
    };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });

    const result = readConfig();
    assert.deepEqual(result, config);
  });

  it('reads config with unicode content', () => {
    const config = { token: 'tok', name: 'ユーザー名' };
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify(config), { mode: 0o600 });

    const result = readConfig();
    assert.equal(result.name, 'ユーザー名');
  });
});

// --- getApiUrl ---

describe('getApiUrl', () => {
  it('returns apiUrl from config when present', () => {
    const config = { apiUrl: 'https://custom-api.example.com' };
    const result = getApiUrl(config);
    assert.equal(result, 'https://custom-api.example.com');
  });

  it('returns default URL when config is null', () => {
    const result = getApiUrl(null);
    assert.ok(result.includes('cloudfunctions.net') || result.length > 0,
      'Should return a non-empty default URL');
  });

  it('returns default URL when config has no apiUrl', () => {
    const result = getApiUrl({ token: 'tok' });
    assert.ok(result.length > 0, 'Should return a non-empty default URL');
  });

  it('returns default URL when config is undefined', () => {
    const result = getApiUrl(undefined);
    assert.ok(result.length > 0, 'Should return a non-empty default URL');
  });

  it('returns default URL when apiUrl is empty string', () => {
    const result = getApiUrl({ apiUrl: '' });
    // Empty string is falsy, so should fall back to default
    assert.ok(result.length > 0, 'Should return default for empty apiUrl');
    assert.notEqual(result, '');
  });
});
