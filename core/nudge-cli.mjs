#!/usr/bin/env node
/**
 * nudge-cli.mjs — Nudge command-line interface.
 *
 * Primary entry point. Mirrors the four MCP tools as subcommands plus
 * `pair` (delegates to nudge-pair.sh) and `mode` (alias for `status --mode`).
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
 *   130 cancelled (SIGINT)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SERVER_VERSION } from './lib/constants.mjs';
import {
  runAskUser,
  runApprove,
  runNotify,
  runStatus,
} from './lib/handlers.mjs';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));

// --- Tiny argv parser (no deps) ---------------------------------------------

function parseArgs(argv) {
  const args = { _: [], options: [], flags: new Set() };
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
      if (key === 'option' || key === 'o') {
        const value = inlineValue ?? argv[++i];
        if (value == null) usageError(`--${key} requires a value`);
        args.options.push(value);
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
      if (key === 'o') {
        const value = argv[++i];
        if (value == null) usageError('-o requires a value');
        args.options.push(value);
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

// --- Output helpers ----------------------------------------------------------

function isJsonMode(args) {
  return args.flags.has('json');
}

function printResult(args, data, humanLines) {
  if (isJsonMode(args)) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }
  for (const line of humanLines) process.stdout.write(line + '\n');
}

function die(code, message) {
  process.stderr.write(`nudge: ${message}\n`);
  process.exit(code);
}

function usageError(message) {
  process.stderr.write(`nudge: ${message}\n`);
  process.stderr.write('Run `nudge --help` for usage.\n');
  process.exit(2);
}

function classifyAndExit(err) {
  const msg = err?.message || String(err);
  if (/not configured|re-pair|no authentication token/i.test(msg)) {
    die(3, msg);
  } else if (/HTTP \d|fetch failed|ECONN|ENOTFOUND|SSE/i.test(msg)) {
    die(4, msg);
  } else if (/required|must be|exceeds maximum|must have/i.test(msg)) {
    die(5, msg);
  } else {
    die(1, msg);
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
  status                        Show pairing + connection status
  mode <nudge|terminal>         Switch ask mode (alias for status --mode)
  notify "Hello"                Fire-and-forget notification
  ask <question> -o val:label   Send a question, wait for an answer
  approve <description>         Send an approval request, exit 0/1

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
    '  Switch ask mode. `nudge` sends questions to your phone; `terminal` keeps them locally.',
  notify:
    'Usage: nudge notify <body>\n' +
    '       nudge notify <title> <body>\n' +
    '       nudge notify --title T --body B [--level info|success|warning|error]\n' +
    '                    [--context C] [--json]\n' +
    '  Send a one-way push notification. One positional arg is the body; title defaults to "Nudge".\n' +
    '  With two or more positional args, the first is title and the rest become body.\n' +
    '  --title and --body override positional values.',
  ask:
    'Usage: nudge ask <question> -o value:label [-o ...] [--multi]\n' +
    '                  [--context C] [--json]\n' +
    '  Send a question, wait for the user to pick on their phone.\n' +
    '  Default output: one selected value per line, then a blank line, then free-text reply.\n' +
    '  With --json: { selectedOptions, freeText }.',
  approve:
    'Usage: nudge approve <description> [--context C] [--json]\n' +
    '  Send an approval request. Exit 0 if approved, 1 if denied.',
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
  printResult(args, result, lines);
  if (!result.paired) process.exit(3);
}

async function cmdMode(args) {
  const target = args._[1];
  if (!target) usageError('mode requires a target: nudge or terminal');
  if (target !== 'nudge' && target !== 'terminal') {
    usageError(`mode must be "nudge" or "terminal" (got "${target}")`);
  }
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

  const payload = {
    title,
    body,
    ...(args.level && { level: args.level }),
    ...(args.context && { context: args.context }),
    ...(args.session && { sessionName: args.session }),
  };
  const result = await runNotify(payload);
  printResult(args, result, ['Notification sent.']);
}

async function cmdAsk(args) {
  const question = args._.slice(1).join(' ').trim();
  if (!question) usageError('ask requires a question argument');
  if (args.options.length < 2) {
    usageError('ask requires at least 2 options (use -o value:label)');
  }
  const session = optionString(args, 'session');
  const options = args.options.map(parseOption);

  const payload = {
    question,
    options,
    multiSelect: args.flags.has('multi'),
    ...(args.context && { context: args.context }),
    ...(session && { sessionName: session }),
  };

  const result = await runAskUser(payload, {
    onEventCreated: installCancel,
  });
  clearCancel();

  const lines = [];
  for (const opt of result.selectedOptions || []) lines.push(opt);
  if (result.freeText) {
    if (lines.length > 0) lines.push('');
    lines.push(result.freeText);
  }
  if (lines.length === 0) lines.push('(no selection)');

  printResult(args, result, lines);
}

async function cmdApprove(args) {
  const description = args._.slice(1).join(' ').trim();
  if (!description) usageError('approve requires a description argument');
  const title = optionString(args, 'title');
  const tool = optionString(args, 'tool');

  let toolInput;
  if (args.input) {
    try {
      toolInput = JSON.parse(args.input);
    } catch (err) {
      usageError(`--input must be valid JSON: ${err.message}`);
    }
  }

  const payload = {
    description,
    ...((title || tool) && { toolName: title || tool }),
    ...(args.cwd && { cwd: args.cwd }),
    ...(args.context && { context: args.context }),
    ...(args.session && { sessionName: args.session }),
    ...(toolInput && { toolInput }),
  };

  const result = await runApprove(payload, {
    onEventCreated: installCancel,
  });
  clearCancel();

  const lines = [
    result.approved ? 'Approved.' : 'Denied.',
    ...(result.reason ? [result.reason] : []),
  ];
  printResult(args, result, lines);

  process.exit(result.approved ? 0 : 1);
}

// --- Dispatcher --------------------------------------------------------------

const COMMANDS = {
  pair: cmdPair,
  status: cmdStatus,
  mode: cmdMode,
  notify: cmdNotify,
  ask: cmdAsk,
  approve: cmdApprove,
};

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

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
