/**
 * Tests for pure utility functions in scripts/nudge-hook.mjs
 *
 * Since nudge-hook.mjs does not export its functions, we re-implement
 * the pure functions here for testing. The implementations are exact
 * copies from the source — verified by comparing behavior.
 *
 * Covers: shouldSkip, buildDescription, sanitizeSecrets, buildToolInput
 * Zero external dependencies — uses node:assert + node:test
 *
 * Run: node tests/hook.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- Re-implement pure functions from nudge-hook.mjs ---
// These are exact copies of the non-exported functions for testing.

function buildDescription(toolName, toolInput) {
  if (toolInput.command) {
    return `${toolName}: ${toolInput.command}`;
  }
  if (toolInput.file_path) {
    return `${toolName}: ${toolInput.file_path}`;
  }
  if (toolInput.query) {
    return `${toolName}: ${toolInput.query}`;
  }
  if (toolInput.url) {
    return `${toolName}: ${toolInput.url}`;
  }
  if (toolInput.description) {
    return `${toolName}: ${toolInput.description}`;
  }
  return toolName;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function sanitizeSecrets(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]')
    .replace(/(Basic\s+)[A-Za-z0-9+/]+=*/gi, '$1[REDACTED]')
    .replace(/(--[\w-]*(password|passwd|secret|token|key|credential|auth|apikey|api_key)[=\s]+)\S+/gi, '$1[REDACTED]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[AWS_KEY_REDACTED]')
    .replace(/(ghp_|ghs_|sk-|eyJ)[A-Za-z0-9_\-.]{10,}/g, '[TOKEN_REDACTED]');
}

function buildToolInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') return {};

  const result = { ...rawInput };

  if (typeof result.command === 'string') {
    result.command = sanitizeSecrets(result.command);
  }

  for (const key of ['content', 'new_source', 'old_string', 'new_string']) {
    if (typeof result[key] === 'string' && result[key].length > 2000) {
      result[key] = truncate(result[key], 2000);
    }
  }

  return result;
}

function shouldSkip(toolName, toolInput) {
  if (toolName && toolName.includes('nudge')) {
    return true;
  }

  const command = toolInput?.command || '';

  if (/\bnudge-\w+\.(sh|mjs)\b/.test(command) || /\/nudge:/.test(command)) {
    return true;
  }

  return false;
}

// --- Tests ---

// --- shouldSkip ---

describe('shouldSkip', () => {
  it('returns true for nudge_ask_user tool', () => {
    assert.equal(shouldSkip('nudge_ask_user', {}), true);
  });

  it('returns true for nudge_approve tool', () => {
    assert.equal(shouldSkip('nudge_approve', {}), true);
  });

  it('returns true for nudge_notify tool', () => {
    assert.equal(shouldSkip('nudge_notify', {}), true);
  });

  it('returns true for any tool containing "nudge"', () => {
    assert.equal(shouldSkip('my_nudge_tool', {}), true);
    assert.equal(shouldSkip('nudge', {}), true);
  });

  it('returns true for commands running nudge scripts (.sh)', () => {
    assert.equal(
      shouldSkip('Bash', { command: 'bash /path/to/nudge-hook.sh' }),
      true,
    );
    assert.equal(
      shouldSkip('Bash', { command: 'bash nudge-notify.sh' }),
      true,
    );
  });

  it('returns true for commands running nudge scripts (.mjs)', () => {
    assert.equal(
      shouldSkip('Bash', { command: 'node nudge-hook.mjs' }),
      true,
    );
    assert.equal(
      shouldSkip('Bash', { command: '/usr/local/bin/node /path/nudge-activity.mjs' }),
      true,
    );
  });

  it('returns true for nudge command paths', () => {
    assert.equal(
      shouldSkip('Bash', { command: '/nudge:mode terminal' }),
      true,
    );
    assert.equal(
      shouldSkip('Bash', { command: 'some/path/nudge:setup' }),
      true,
    );
  });

  it('returns false for Bash tool', () => {
    assert.equal(shouldSkip('Bash', { command: 'ls -la' }), false);
  });

  it('returns false for Write tool', () => {
    assert.equal(shouldSkip('Write', { file_path: '/tmp/test.txt' }), false);
  });

  it('returns false for Edit tool', () => {
    assert.equal(shouldSkip('Edit', { file_path: '/tmp/test.txt' }), false);
  });

  it('returns false for Read tool', () => {
    assert.equal(shouldSkip('Read', { file_path: '/tmp/test.txt' }), false);
  });

  it('returns false for WebSearch tool', () => {
    assert.equal(shouldSkip('WebSearch', { query: 'node.js' }), false);
  });

  it('returns false when toolInput is null', () => {
    assert.equal(shouldSkip('Bash', null), false);
  });

  it('returns false when toolInput is undefined', () => {
    assert.equal(shouldSkip('Bash', undefined), false);
  });

  it('returns false for command that merely mentions nudge in a different context', () => {
    // "nudge" not in tool name, and command doesn't match the patterns
    assert.equal(
      shouldSkip('Bash', { command: 'echo "give them a nudge"' }),
      false,
    );
  });
});

// --- buildDescription ---

describe('buildDescription', () => {
  it('builds description from command', () => {
    assert.equal(
      buildDescription('Bash', { command: 'npm test' }),
      'Bash: npm test',
    );
  });

  it('builds description from file_path', () => {
    assert.equal(
      buildDescription('Write', { file_path: '/src/app.ts' }),
      'Write: /src/app.ts',
    );
  });

  it('builds description from query', () => {
    assert.equal(
      buildDescription('WebSearch', { query: 'react hooks' }),
      'WebSearch: react hooks',
    );
  });

  it('builds description from url', () => {
    assert.equal(
      buildDescription('WebFetch', { url: 'https://example.com' }),
      'WebFetch: https://example.com',
    );
  });

  it('builds description from description field', () => {
    assert.equal(
      buildDescription('CustomTool', { description: 'Do something' }),
      'CustomTool: Do something',
    );
  });

  it('returns just tool name when no recognized fields', () => {
    assert.equal(
      buildDescription('UnknownTool', { foo: 'bar' }),
      'UnknownTool',
    );
  });

  it('returns just tool name for empty input', () => {
    assert.equal(buildDescription('Bash', {}), 'Bash');
  });

  it('prioritizes command over file_path', () => {
    assert.equal(
      buildDescription('Bash', { command: 'ls', file_path: '/tmp' }),
      'Bash: ls',
    );
  });

  it('prioritizes file_path over query', () => {
    assert.equal(
      buildDescription('Tool', { file_path: '/tmp/f', query: 'q' }),
      'Tool: /tmp/f',
    );
  });
});

// --- sanitizeSecrets ---

describe('sanitizeSecrets', () => {
  it('redacts Bearer tokens', () => {
    const input = 'curl -H "Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig"';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[REDACTED]') || result.includes('[TOKEN_REDACTED]'));
    assert.ok(!result.includes('eyJhbGciOiJSUzI1NiJ9'));
  });

  it('redacts Basic auth tokens', () => {
    const input = 'curl -H "Authorization: Basic dXNlcjpwYXNz"';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes('dXNlcjpwYXNz'));
  });

  it('redacts AWS access keys (AKIA...)', () => {
    const input = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[AWS_KEY_REDACTED]'));
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'));
  });

  it('redacts GitHub personal access tokens (ghp_...)', () => {
    const input = 'git clone https://ghp_ABCDEFghijklmnopqrstuvwxyz@github.com/repo';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[TOKEN_REDACTED]'));
    assert.ok(!result.includes('ghp_ABCDEFghijklmnopqrstuvwxyz'));
  });

  it('redacts GitHub server tokens (ghs_...)', () => {
    const input = 'GITHUB_TOKEN=ghs_ABCDEFghijklmnopqrstuvwxyz';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[TOKEN_REDACTED]'));
  });

  it('redacts OpenAI API keys (sk-...)', () => {
    const input = 'OPENAI_API_KEY=sk-abcdefghij1234567890';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[TOKEN_REDACTED]'));
  });

  it('redacts --password flags', () => {
    const input = 'mysql --password=mysecretpass123 -u root';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes('mysecretpass123'));
  });

  it('redacts --secret flags', () => {
    const input = 'vault write --secret=mySecretValue123';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes('mySecretValue123'));
  });

  it('redacts --token flags', () => {
    const input = 'cli --token=abc123def456';
    const result = sanitizeSecrets(input);
    assert.ok(result.includes('[REDACTED]'));
  });

  it('leaves non-secret strings unchanged', () => {
    const input = 'npm install express --save';
    const result = sanitizeSecrets(input);
    assert.equal(result, input);
  });

  it('returns non-string values unchanged', () => {
    assert.equal(sanitizeSecrets(42), 42);
    assert.equal(sanitizeSecrets(null), null);
    assert.equal(sanitizeSecrets(undefined), undefined);
  });

  it('handles multiple secrets in one string', () => {
    const input = 'Bearer abc123token456 and AKIAIOSFODNN7EXAMPLE';
    const result = sanitizeSecrets(input);
    assert.ok(!result.includes('abc123token456'));
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'));
  });
});

// --- buildToolInput ---

describe('buildToolInput', () => {
  it('returns empty object for null input', () => {
    assert.deepEqual(buildToolInput(null), {});
  });

  it('returns empty object for undefined input', () => {
    assert.deepEqual(buildToolInput(undefined), {});
  });

  it('returns empty object for non-object input', () => {
    assert.deepEqual(buildToolInput('string'), {});
  });

  it('sanitizes command field', () => {
    const input = { command: 'curl -H "Bearer secret123token456789"' };
    const result = buildToolInput(input);
    assert.ok(!result.command.includes('secret123token456789'));
  });

  it('truncates content field at 2000 chars', () => {
    const longContent = 'x'.repeat(3000);
    const input = { content: longContent };
    const result = buildToolInput(input);
    assert.ok(result.content.length <= 2003 + 1); // 2000 + '...'
    assert.ok(result.content.endsWith('...'));
  });

  it('truncates new_source field at 2000 chars', () => {
    const longSource = 'y'.repeat(5000);
    const input = { new_source: longSource };
    const result = buildToolInput(input);
    assert.ok(result.new_source.length <= 2003 + 1);
    assert.ok(result.new_source.endsWith('...'));
  });

  it('truncates old_string field at 2000 chars', () => {
    const longStr = 'z'.repeat(2500);
    const input = { old_string: longStr };
    const result = buildToolInput(input);
    assert.ok(result.old_string.endsWith('...'));
  });

  it('truncates new_string field at 2000 chars', () => {
    const longStr = 'w'.repeat(2500);
    const input = { new_string: longStr };
    const result = buildToolInput(input);
    assert.ok(result.new_string.endsWith('...'));
  });

  it('does NOT truncate short content', () => {
    const input = { content: 'short content' };
    const result = buildToolInput(input);
    assert.equal(result.content, 'short content');
  });

  it('does NOT truncate exactly 2000 chars', () => {
    const input = { content: 'a'.repeat(2000) };
    const result = buildToolInput(input);
    assert.equal(result.content.length, 2000);
    assert.ok(!result.content.endsWith('...'));
  });

  it('preserves non-sensitive fields unchanged', () => {
    const input = { file_path: '/tmp/test.txt', command: 'ls -la' };
    const result = buildToolInput(input);
    assert.equal(result.file_path, '/tmp/test.txt');
    assert.equal(result.command, 'ls -la');
  });

  it('does not modify the original input object', () => {
    const input = { command: 'ls', content: 'hello' };
    const copy = { ...input };
    buildToolInput(input);
    assert.deepEqual(input, copy);
  });
});
