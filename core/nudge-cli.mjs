#!/usr/bin/env node
/**
 * nudge-cli.mjs — Nudge command-line interface.
 *
 * Primary entry point. Mirrors the four MCP tools as subcommands plus
 * `pair` (delegates to nudge-pair.sh).
 *
 * `mode` is a deprecated alias for `status --mode` and will be removed in v1.3.
 *
 * Usage: nudge <subcommand> [options]
 *
 * Exit codes:
 *   0   success / approved
 *   1   approve denied (only `approve`)
 *   2   usage / argument error
 *   3   not paired
 *   4   network / server error
 *   5   validation / handler error
 *   6   timed out waiting for a decision (--ttl)
 *   130 cancelled (SIGINT)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { SERVER_VERSION } from './lib/constants.mjs';
import {
  runAskUser,
  runApprove,
  runNotify,
  runStatus,
} from './lib/handlers.mjs';
import { runWrappedCommand } from './lib/run-wrap.mjs';
import { unlinkSync } from 'node:fs';
import {
  listAllPending,
  findPendingByEventId,
  postCancel,
} from './lib/pending-files.mjs';
import { loadAttachment } from './lib/attachments.mjs';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));

// --- Tiny argv parser (no deps) ---------------------------------------------

// Flags that accumulate multiple values into an array on `args`.
// Both long form (`--<key>`) and the short alias map to the same bucket.
// `--image` / `--file` share the `attachmentPaths` bucket — mime is
// auto-detected so the two flags differ only by user intent (and `--files`
// plural is unrelated, it's a comma-separated structured-context flag).
const ACCUMULATING_FLAGS = {
  o: 'options',
  option: 'options',
  action: 'actions',
  image: 'attachmentPaths',
  file: 'attachmentPaths',
};

function parseArgs(argv) {
  const args = { _: [], options: [], actions: [], attachmentPaths: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const key = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const inlineValue = eq >= 0 ? tok.slice(eq + 1) : undefined;
      if (ACCUMULATING_FLAGS[key]) {
        const value = inlineValue ?? argv[++i];
        if (value == null) usageError(`--${key} requires a value`);
        args[ACCUMULATING_FLAGS[key]].push(value);
      } else if (inlineValue !== undefined) {
        args[key] = inlineValue;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        args[key] = argv[++i];
      } else {
        args.flags.add(key);
        args[key] = true;
      }
    } else if (tok.startsWith('-') && tok.length > 1) {
      const key = tok.slice(1);
      if (ACCUMULATING_FLAGS[key]) {
        const value = argv[++i];
        if (value == null) usageError(`-${key} requires a value`);
        args[ACCUMULATING_FLAGS[key]].push(value);
      } else if (key === 'h') {
        args.flags.add('help');
        args.help = true;
      } else if (key === 'V') {
        args.flags.add('version');
        args.version = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        args[key] = argv[++i];
      } else {
        args.flags.add(key);
        args[key] = true;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function parseOption(spec) {
  // "value:label" or "value:label:description"
  const parts = spec.split(':');
  if (parts.length < 2) usageError(`option must be "value:label" (got "${spec}")`);
  const [value, label, ...rest] = parts;
  const description = rest.join(':');
  if (!value || !label) usageError(`option must have both value and label (got "${spec}")`);
  return description ? { value, label, description } : { value, label };
}

function optionString(args, key) {
  const value = args[key];
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    usageError(`--${key} requires a value`);
  }
  return value;
}

function parseAttachments(args) {
  if (!args.attachmentPaths || args.attachmentPaths.length === 0) return [];
  try {
    return args.attachmentPaths.map((p) => loadAttachment(p));
  } catch (err) {
    usageError(err.message);
  }
}

function parseTtl(args) {
  if (args.ttl === undefined) return undefined;
  const n = Number(args.ttl);
  if (!Number.isFinite(n) || n <= 0) {
    usageError(`--ttl must be a positive number of seconds (got "${args.ttl}")`);
  }
  return n;
}

// Structured-context flags shared by ask/approve/notify.
// Returns an object suitable for embedding inside the encrypted payload,
// or undefined when no flag was passed.
function parseStructured(args) {
  const out = {};
  if (args.diff) {
    try {
      out.diff = readFileSync(args.diff, 'utf-8');
    } catch (err) {
      usageError(`--diff: cannot read "${args.diff}": ${err.message}`);
    }
  }
  if (args.files) {
    out.files = String(args.files)
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }
  if (args['exit-code'] !== undefined) {
    const n = Number(args['exit-code']);
    if (!Number.isFinite(n)) {
      usageError(`--exit-code must be a number (got "${args['exit-code']}")`);
    }
    out.exitCode = n;
  }
  if (args['tool-name']) {
    out.toolName = String(args['tool-name']);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// --- Output helpers ----------------------------------------------------------
//
// Two JSON envelope versions are supported:
//   v1 (default): each command emits its own ad-hoc shape (back-compat).
//   v2 (opt-in via NUDGE_JSON_VERSION=2):
//     success → { ok: true,  command, data }
//     error   → { ok: false, command, error: { code, message } }
//
// v2 unifies output so callers can branch on `ok` and `error.code` without
// per-command parsing. v1 stays available until the next major bump.

let activeArgs = null;

function setActiveArgs(args) {
  activeArgs = args;
}

function jsonVersion() {
  return process.env.NUDGE_JSON_VERSION === '2' ? 2 : 1;
}

function isJsonMode() {
  return activeArgs?.flags?.has('json') === true;
}

function activeCommand() {
  return activeArgs?._?.[0] || 'unknown';
}

const EXIT_TO_ERROR_CODE = {
  1: 'ERROR',
  2: 'USAGE',
  3: 'NOT_PAIRED',
  4: 'NETWORK',
  5: 'VALIDATION',
  6: 'TIMEOUT',
  130: 'CANCELLED',
};

function printResult(data, humanLines) {
  if (isJsonMode()) {
    const payload = jsonVersion() === 2
      ? { ok: true, command: activeCommand(), data }
      : data;
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }
  for (const line of humanLines) process.stdout.write(line + '\n');
}

function die(code, message, errorCode) {
  if (isJsonMode() && jsonVersion() === 2) {
    const payload = {
      ok: false,
      command: activeCommand(),
      error: {
        code: errorCode || EXIT_TO_ERROR_CODE[code] || 'ERROR',
        message,
      },
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stderr.write(`nudge: ${message}\n`);
  }
  process.exit(code);
}

function usageError(message) {
  if (isJsonMode() && jsonVersion() === 2) {
    die(2, message, 'USAGE');
  }
  process.stderr.write(`nudge: ${message}\n`);
  process.stderr.write('Run `nudge --help` for usage.\n');
  process.exit(2);
}

function classifyAndExit(err) {
  const msg = err?.message || String(err);
  if (/not configured|re-pair|no authentication token/i.test(msg)) {
    die(3, msg, 'NOT_PAIRED');
  } else if (/HTTP \d|fetch failed|ECONN|ENOTFOUND|SSE/i.test(msg)) {
    die(4, msg, 'NETWORK');
  } else if (/required|must be|exceeds maximum|must have|^no pending event/i.test(msg)) {
    die(5, msg, 'VALIDATION');
  } else {
    die(1, msg, 'ERROR');
  }
}

// --- SIGINT cancellation -----------------------------------------------------

let pendingCancel = null;
process.on('SIGINT', async () => {
  if (pendingCancel) {
    try { await pendingCancel(); } catch { /* best effort */ }
  }
  process.exit(130);
});

function installCancel(ctx) {
  pendingCancel = ctx.cancel;
}

function clearCancel() {
  pendingCancel = null;
}

// --- Subcommands -------------------------------------------------------------

const HELP = `nudge — Approve coding AI actions from your phone (CLI)

Usage:
  nudge <subcommand> [options]

Subcommands:
  pair                          Pair your phone (generate code, scan in app)
  status [--mode nudge|terminal] Show pairing + connection status, switch mode
  notify "Hello"                Fire-and-forget notification
  ask <question> -o val:label   Send a question, wait for an answer
  approve <description>         Send an approval request, exit 0/1
  cancel <event-id|--last|--all|--session name>
                                Cancel an in-flight mobile event from another process
  run -- <cmd> [args...]        Wrap a command; notify on exit with code + duration + tail

Common options:
  --json                        Emit JSON to stdout (default: human-readable)
  -h, --help                    Show this help
  -V, --version                 Print version

Examples:
  nudge pair
  nudge notify "Hello"
  nudge notify --title "Build" --body "deploy.sh succeeded" --level success
  nudge approve "Deploy v1.2.3 to prod?" && ./deploy.sh
  nudge ask "Pick env" -o dev:Dev -o prod:Prod --json

Exit codes:
  0 success / approved, 1 denied, 2 usage, 3 not paired,
  4 network error, 5 validation error, 130 cancelled.
`;

const HELP_BY_CMD = {
  pair: 'Usage: nudge pair\n  Generate a pairing code and wait for the mobile app to claim it.',
  status:
    'Usage: nudge status [--mode nudge|terminal] [--json]\n' +
    '  Show pairing state, server connectivity, auth token validity, ask mode.',
  mode:
    'Usage: nudge mode <nudge|terminal> [--json]\n' +
    '  DEPRECATED — use `nudge status --mode <target>` instead.\n' +
    '  Will be removed in v1.3.',
  notify:
    'Usage: nudge notify <body>\n' +
    '       nudge notify <title> <body>\n' +
    '       nudge notify --title T --body B [--level info|success|warning|error]\n' +
    '                    [--context C] [--diff <path>] [--files a,b,c]\n' +
    '                    [--exit-code N] [--tool-name S] [--json]\n' +
    '  Send a one-way push notification. One positional arg is the body; title defaults to "Nudge".\n' +
    '  With two or more positional args, the first is title and the rest become body.\n' +
    '  --title and --body override positional values.',
  ask:
    'Usage: nudge ask <question> -o value:label [-o ...] [--multi]\n' +
    '                  [--text] [--action key:label[:desc]] [...]\n' +
    '                  [--ttl <seconds>]\n' +
    '                  [--context C] [--diff <path>] [--files a,b,c]\n' +
    '                  [--exit-code N] [--tool-name S] [--json]\n' +
    '  Send a question, wait for the user to answer on their phone.\n' +
    '  Provide curated options via -o, free-form input via --text, follow-up\n' +
    '  actions via --action, or any combination. At least one of those three\n' +
    '  must be present.\n' +
    '  With --ttl, exit 6 if no decision arrives within <seconds>.\n' +
    '  Default output: one selected value per line, then a blank line, then\n' +
    '  free-text reply, then "action: <key>" when a follow-up action was picked.\n' +
    '  With --json: { selectedOptions, freeText, selectedAction?, timedOut? }.',
  approve:
    'Usage: nudge approve <description> [--ttl <seconds>] [--context C]\n' +
    '                       [--action key:label[:desc]] [...]\n' +
    '                       [--diff <path>] [--files a,b,c] [--exit-code N] [--tool-name S] [--json]\n' +
    '  Send an approval request. Exit 0 if approved, 1 if denied or if the user\n' +
    '  picks a follow-up --action (so `approve && deploy` stays safe).\n' +
    '  With --ttl, exit 6 if no decision arrives within <seconds>.',
  cancel:
    'Usage: nudge cancel <event-id>\n' +
    '       nudge cancel --session <name>\n' +
    '       nudge cancel --last\n' +
    '       nudge cancel --all\n' +
    '  Cancel one or more in-flight mobile events from another process.\n' +
    '  Exactly one selector must be given. Targets are taken from\n' +
    '  ~/.nudge/pending-*.json — the same tracking files used by hooks.\n' +
    '  Exit 0 on success (including "nothing to cancel"); 5 when an explicit\n' +
    '  <event-id> or --session does not match any pending event.',
  run:
    'Usage: nudge run [--on success|fail|always] [--tail N] [--title T]\n' +
    '                 [--ask] [--context C] [--session N] [--json] -- <cmd> [args...]\n' +
    '  Run <cmd> as a child process, stream its stdout/stderr through, and\n' +
    '  notify when it exits with exit code, duration, and the last N lines.\n' +
    '  Default: notify always, tail=50, title=<cmd>, level=success|error.\n' +
    '  --on fail / success limits notifications to that outcome.\n' +
    '  --ask uses an approve flow instead of notify (returns 0 on approve,\n' +
    '  1 on deny, otherwise the child\'s exit code is propagated).\n' +
    '  The `--` separator is recommended so flags on <cmd> aren\'t consumed\n' +
    '  by the nudge parser.',
};

async function cmdPair() {
  const script = join(CLI_DIR, 'nudge-pair.sh');
  return new Promise((resolve) => {
    const child = spawn('bash', [script], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`nudge: failed to launch pair script: ${err.message}\n`);
      resolve(1);
    });
  });
}

async function cmdStatus(args) {
  const result = await runStatus(args.mode ? { mode: args.mode } : {});
  const lines = [];
  if (!result.paired) {
    lines.push(result.message || 'Not paired. Run `nudge pair` to connect your phone.');
  } else {
    lines.push(`Paired:         yes`);
    lines.push(`User ID:        ${result.userId}`);
    lines.push(`Pairing code:   ${result.pairingCode}`);
    lines.push(`Server:         ${result.server}`);
    lines.push(`Server status:  ${result.serverStatus ?? 'unknown'}`);
    if (result.backendVersion) lines.push(`Backend version: ${result.backendVersion}`);
    lines.push(`Auth:           ${result.authStatus ?? 'unknown'}`);
    lines.push(`Ask mode:       ${result.askMode}`);
    lines.push(`Plugin version: ${result.pluginVersion}`);
    if (result.modeChanged) lines.push('');
    if (result.modeChanged && result.message) lines.push(result.message);
  }
  printResult(result, lines);
  if (!result.paired) process.exit(3);
}

async function cmdMode(args) {
  const target = args._[1];
  if (!target) usageError('mode requires a target: nudge or terminal');
  if (target !== 'nudge' && target !== 'terminal') {
    usageError(`mode must be "nudge" or "terminal" (got "${target}")`);
  }
  process.stderr.write(
    'nudge: `nudge mode` is deprecated and will be removed in v1.3. ' +
    'Use `nudge status --mode <target>` instead.\n',
  );
  return cmdStatus({ ...args, mode: target });
}

async function cmdNotify(args) {
  const positional = args._.slice(1);
  const positionalTitle = positional.length >= 2 ? positional[0] : undefined;
  const positionalBody = positional.length >= 2
    ? positional.slice(1).join(' ').trim()
    : positional.join(' ').trim();
  const title = args.title || positionalTitle || 'Nudge';
  const body = args.body || positionalBody;
  if (!body) usageError('notify requires a body (pass a message or --body)');

  const structured = parseStructured(args);
  const attachments = parseAttachments(args);
  const payload = {
    title,
    body,
    ...(args.level && { level: args.level }),
    ...(args.context && { context: args.context }),
    ...(structured && { structured }),
    ...(attachments.length > 0 && { attachments }),
    ...(args.session && { sessionName: args.session }),
  };
  const result = await runNotify(payload);
  printResult(result, ['Notification sent.']);
}

async function cmdAsk(args) {
  const question = args._.slice(1).join(' ').trim();
  if (!question) usageError('ask requires a question argument');

  const textOnly = args.flags.has('text');
  const options = args.options.map(parseOption);
  const actions = args.actions.map(parseOption);

  if (!textOnly && options.length === 0 && actions.length === 0) {
    usageError('ask requires options (-o), --text, or at least one --action');
  }
  if (options.length > 0 && options.length < 2) {
    usageError('ask requires at least 2 options (use -o value:label)');
  }

  const session = optionString(args, 'session');
  const structured = parseStructured(args);
  const attachments = parseAttachments(args);
  const ttl = parseTtl(args);

  const payload = {
    question,
    options,
    actions,
    multiSelect: args.flags.has('multi'),
    ...(textOnly && { textOnly: true }),
    ...(args.context && { context: args.context }),
    ...(structured && { structured }),
    ...(attachments.length > 0 && { attachments }),
    ...(ttl !== undefined && { ttl }),
    ...(session && { sessionName: session }),
  };

  const result = await runAskUser(payload, {
    onEventCreated: installCancel,
  });
  clearCancel();

  if (result.timedOut) {
    printResult(result, ['(timed out waiting for an answer)']);
    process.exit(6);
  }

  const lines = [];
  for (const opt of result.selectedOptions || []) lines.push(opt);
  if (result.freeText) {
    if (lines.length > 0) lines.push('');
    lines.push(result.freeText);
  }
  if (result.selectedAction) {
    if (lines.length > 0) lines.push('');
    lines.push(`action: ${result.selectedAction}`);
  }
  if (lines.length === 0) lines.push('(no selection)');

  printResult(result, lines);

  // Force exit on the success path. Like `approve`, `ask` waits on an SSE
  // stream and undici keeps the underlying fetch sockets alive in its
  // keep-alive pool, so the event loop never drains on its own — without this
  // the process hangs after the answer is printed (bg `ask` never completes,
  // so the caller sees "no answer received" even though it arrived).
  process.exit(0);
}

async function cmdApprove(args) {
  const description = args._.slice(1).join(' ').trim();
  if (!description) usageError('approve requires a description argument');

  for (const flag of ['title', 'tool', 'input', 'cwd']) {
    if (args[flag] !== undefined) {
      process.stderr.write(
        `nudge: --${flag} on \`approve\` is no longer supported on the CLI ` +
        `(it was undocumented and reserved for MCP); ignoring.\n`,
      );
    }
  }

  const actions = args.actions.map(parseOption);
  const structured = parseStructured(args);
  const attachments = parseAttachments(args);
  const ttl = parseTtl(args);

  const payload = {
    description,
    ...(actions.length > 0 && { actions }),
    ...(structured && { structured }),
    ...(attachments.length > 0 && { attachments }),
    ...(ttl !== undefined && { ttl }),
    ...(args.context && { context: args.context }),
    ...(args.session && { sessionName: args.session }),
  };

  const result = await runApprove(payload, {
    onEventCreated: installCancel,
  });
  clearCancel();

  if (result.timedOut) {
    printResult(result, ['(timed out waiting for approval)']);
    process.exit(6);
  }

  const lines = [
    result.approved ? 'Approved.' : (result.selectedAction ? `Action: ${result.selectedAction}` : 'Denied.'),
    ...(result.reason ? [result.reason] : []),
  ];
  // In v2 JSON mode, "denied" / "selectedAction" are still a successful
  // operation (the user exercised choice). The exit code carries the
  // decision, not the envelope. A follow-up action is treated as
  // not-approved for shell-chain safety (`approve && deploy` won't proceed
  // when the user asked for something else first).
  printResult(result, lines);

  process.exit(result.approved ? 0 : 1);
}

// --- cmdRun ------------------------------------------------------------------
//
// Wrap a child command and notify when it finishes. CLI-only: no backend or
// mobile changes required — internally calls runNotify (or runApprove with
// `--ask`).
//
// Notification fields populated from the wrap:
//   - title:      --title T, else the basename of the child command
//   - body:       "exit <code> • <durationS>s"
//   - level:      "success" on exit 0, "error" otherwise
//   - context:    tail of stdout+stderr (last N non-empty lines)
//   - structured: { exitCode, toolName: title }

async function cmdRun(args) {
  const cmd = args._[1];
  if (!cmd) {
    usageError('run requires a command (use: nudge run [--flags] -- <cmd> [args...])');
  }
  const cmdArgv = args._.slice(2);

  const on = args.on || 'always';
  if (!['success', 'fail', 'always'].includes(on)) {
    usageError(`--on must be one of success|fail|always (got "${on}")`);
  }

  let tailLines = 50;
  if (args.tail !== undefined) {
    const n = Number(args.tail);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      usageError(`--tail must be a non-negative integer (got "${args.tail}")`);
    }
    tailLines = n;
  }

  const title = optionString(args, 'title') || basename(cmd) || cmd;
  const session = optionString(args, 'session');

  const result = await runWrappedCommand(cmd, cmdArgv, { tailLines });
  const isFail = result.exitCode !== 0;
  const shouldNotify =
    on === 'always' || (on === 'fail' && isFail) || (on === 'success' && !isFail);

  if (shouldNotify) {
    const durationS = (result.durationMs / 1000).toFixed(1);
    const exitLabel = result.signal
      ? `signal ${result.signal}`
      : `exit ${result.exitCode}`;
    const body = `${exitLabel} • ${durationS}s`;
    const context = result.tail.length > 0
      ? result.tail.slice(-tailLines).join('\n')
      : undefined;
    const structured = {
      exitCode: result.exitCode === null ? -1 : result.exitCode,
      toolName: title,
    };

    try {
      if (args.flags.has('ask')) {
        const approval = await runApprove({
          description: `${title}: ${body}`,
          ...(args.context && { context: args.context }),
          ...(context && !args.context && { context }),
          structured,
          ...(session && { sessionName: session }),
        }, { onEventCreated: installCancel });
        clearCancel();
        // Approve flow: 0 if user approved, otherwise 1 (deny / timeout / action).
        process.exit(approval.approved ? 0 : 1);
      } else {
        await runNotify({
          title,
          body,
          level: isFail ? 'error' : 'success',
          ...(args.context && { context: args.context }),
          ...(context && !args.context && { context }),
          structured,
          ...(session && { sessionName: session }),
        });
      }
    } catch (err) {
      // Best-effort: a missing pair or network error must not mask the child's
      // own exit code. Log and fall through to propagate.
      process.stderr.write(`nudge: notification skipped (${err.message})\n`);
    }
  }

  // Propagate the child's exit code so `nudge run -- make test` is a safe
  // drop-in replacement for `make test` in CI pipelines.
  process.exit(result.exitCode === null ? 1 : result.exitCode);
}

// --- cmdCancel ---------------------------------------------------------------
//
// Resolve targets from `~/.nudge/pending-*.json`, then issue
// `POST /eventsRespond/:id/respond {action: "cancelled"}` for each.
// CLI-only — no backend changes required (uses the same endpoint that the
// SIGINT path uses today).

function selectorsGiven(args) {
  const eventIdPositional = args._[1];
  return [
    eventIdPositional,
    args.session,
    args.flags.has('last'),
    args.flags.has('all'),
  ].filter(Boolean).length;
}

async function cmdCancel(args) {
  const count = selectorsGiven(args);
  if (count === 0) {
    usageError('cancel requires exactly one selector: <event-id>, --session <name>, --last, or --all');
  }
  if (count > 1) {
    usageError('cancel selectors are mutually exclusive — pick one of <event-id>, --session, --last, --all');
  }

  const eventIdTarget = args._[1];
  const sessionTarget = args.session;

  let targets;
  if (eventIdTarget) {
    // Fast path — only parse files whose name matches the eventId suffix
    // instead of loading every pending JSON.
    targets = findPendingByEventId(eventIdTarget);
    if (targets.length === 0) {
      throw new Error(`No pending event found with id "${eventIdTarget}"`);
    }
  } else if (sessionTarget) {
    targets = listAllPending().filter(
      (p) => p.data.sessionName === sessionTarget || p.data.sessionId === sessionTarget,
    );
    if (targets.length === 0) {
      throw new Error(`No pending events found for session "${sessionTarget}"`);
    }
  } else {
    const pending = listAllPending();
    if (pending.length === 0) {
      printResult({ cancelled: 0, events: [] }, ['No pending events to cancel.']);
      return;
    }
    targets = args.flags.has('last')
      ? [pending.reduce((newest, p) =>
          (p.data.createdAt ?? 0) > (newest.data.createdAt ?? 0) ? p : newest,
        )]
      : pending;
  }

  const cancelled = [];
  await Promise.all(targets.map(async ({ file, data }) => {
    if (!data.eventId || !data.apiUrl || !data.token) return;
    await postCancel({
      apiUrl: data.apiUrl,
      eventId: data.eventId,
      token: data.token,
      reason: 'Cancelled via nudge cancel',
    });
    // Delete the file directly. We already have its path from
    // listAllPending — going through clearPending would re-derive the
    // path from sessionId+eventId, which fails for pre-1.2 files whose
    // sessionId fallback misparses Firebase-style eventIds (those start
    // with `-`, confusing the last-dash heuristic).
    try { unlinkSync(file); } catch { /* ignore */ }
    cancelled.push({
      eventId: data.eventId,
      sessionId: data.sessionId,
      ...(data.sessionName && { sessionName: data.sessionName }),
      ...(data.toolName && { toolName: data.toolName }),
    });
  }));

  const lines = cancelled.length === 0
    ? ['No pending events to cancel.']
    : [
        `Cancelled ${cancelled.length} event(s):`,
        ...cancelled.map((c) =>
          `  ${c.eventId}${c.sessionName ? ` — ${c.sessionName}` : ''}${c.toolName ? ` (${c.toolName})` : ''}`,
        ),
      ];
  printResult({ cancelled: cancelled.length, events: cancelled }, lines);
}

// --- Dispatcher --------------------------------------------------------------

const COMMANDS = {
  pair: cmdPair,
  status: cmdStatus,
  mode: cmdMode,
  notify: cmdNotify,
  ask: cmdAsk,
  approve: cmdApprove,
  cancel: cmdCancel,
  run: cmdRun,
};

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  setActiveArgs(args);

  if (args.flags.has('version')) {
    process.stdout.write(`nudge ${SERVER_VERSION}\n`);
    return;
  }

  const sub = args._[0];

  if (!sub || args.flags.has('help')) {
    if (sub && HELP_BY_CMD[sub]) {
      process.stdout.write(HELP_BY_CMD[sub] + '\n');
      return;
    }
    process.stdout.write(HELP);
    return;
  }

  if (sub && HELP_BY_CMD[sub] && args._[1] === 'help') {
    process.stdout.write(HELP_BY_CMD[sub] + '\n');
    return;
  }

  const fn = COMMANDS[sub];
  if (!fn) usageError(`unknown subcommand: ${sub}`);

  try {
    if (sub === 'pair') {
      const code = await fn();
      process.exit(code);
    }
    await fn(args);
  } catch (err) {
    classifyAndExit(err);
  }
}

main().catch((err) => {
  classifyAndExit(err);
});
