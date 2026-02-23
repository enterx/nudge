# Contributing to Nudge

Thank you for your interest in contributing. This document covers the setup, conventions, and process for submitting changes.

## Philosophy

- **Zero npm dependencies.** Node.js built-ins only (`fs`, `path`, `os`, `readline`, `child_process`). If Node.js ships it, use it. Otherwise, implement it yourself.
- **Graceful degradation.** Every hook exits 0 on failure. Claude Code must never get stuck because of Nudge.
- **No `jq` requirement in JavaScript.** Bash scripts may use `jq` when available but must provide a grep/sed fallback. Node.js scripts use `JSON.parse`.
- **Bash portability.** Target bash 3.2+ (macOS default). Use POSIX-compatible constructs where possible.

## Prerequisites

- Node.js 18+ (for built-in `fetch`)
- bash 3.2+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with plugin support
- [shellcheck](https://github.com/koalaman/shellcheck) (optional, for linting bash scripts)

## Dev setup

1. Clone the repository:

```bash
git clone https://github.com/user/nudge-plugin.git
cd nudge-plugin
```

2. Load the plugin in Claude Code:

```bash
claude --plugin-dir ./plugins/nudge
```

3. Make changes, then restart Claude Code to pick up hook/MCP changes.

For rapid iteration on scripts that do not affect hooks registration or MCP server startup, you can test them directly:

```bash
echo '{}' | bash scripts/nudge-session-start.sh
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node scripts/nudge-hook.mjs
```

## Project structure

| Directory | Purpose |
|-----------|---------|
| `scripts/` | Bash and Node.js scripts executed by hooks and slash commands |
| `scripts/lib.sh` | Shared bash utilities: config I/O, HTTP helpers, JSON extraction, logging |
| `servers/` | MCP server (`nudge-mcp-server.mjs`) |
| `commands/` | Slash command definitions (`.md` files) |
| `hooks/` | Hook registration (`hooks.json`) |

### Key files

- **`lib.sh`**: Every bash script sources this. It provides `config_read`, `config_write`, `api_post`, `api_get`, `json_extract`, `graceful_exit`, and token management.
- **`nudge-hook.mjs`**: The core PermissionRequest handler. Reads stdin (hook input JSON), posts to the Nudge API, waits for SSE response, outputs an allow/deny decision.
- **`nudge-mcp-server.mjs`**: JSON-RPC 2.0 over stdio. Implements `nudge_ask_user`, `nudge_approve`, `nudge_notify`.

## Running tests

```bash
bash scripts/nudge-scripts.test.sh
```

The test suite uses a temporary `$HOME` directory to isolate config state. It tests:

- `lib.sh` functions: `config_exists`, `config_read`, `config_write`, `json_extract`, `get_api_url`, `is_token_expired`, `graceful_exit`
- Shell hooks: `nudge-session-start.sh`, `nudge-mode.sh`, `nudge-notify.sh`, `nudge-session-end.sh`

Network-dependent tests (hooks that call the API) are not included. Use `/nudge:test` in a live Claude Code session for end-to-end verification.

## Code style

### Bash

- Use `set -euo pipefail` at the top of every script (via `lib.sh`).
- Quote all variable expansions: `"${VAR}"`, not `$VAR`.
- Use `local` for function-scoped variables.
- Run `shellcheck scripts/*.sh` before submitting.
- Use `$(command)` instead of backticks.

### Node.js

- ES modules (`.mjs` extension).
- No external dependencies. Only `node:*` imports.
- Use `async/await` over callbacks.
- Handle all errors: catch and exit 0 for hooks, return `isError: true` for MCP.

### General

- No TypeScript in the plugin. Keep it simple: bash + vanilla Node.js.
- Comments should explain *why*, not *what*.
- Keep functions short. If a function exceeds 40 lines, consider splitting.

## Adding a new hook

1. Write the script in `scripts/` (bash or Node.js).
2. Register it in `hooks/hooks.json` under the appropriate event.
3. Set `timeout` appropriately:
   - Sync hooks (blocking): keep it short (5-30s). Use 86400 for PermissionRequest (user may be AFK).
   - Async hooks (fire-and-forget): 10-30s is typical.
4. Decide on `async: true` (non-blocking) or omit for sync (blocking).
5. Test with `echo '<json>' | bash scripts/your-script.sh` or `| node scripts/your-script.mjs`.
6. Add tests to `nudge-scripts.test.sh` if it is a bash script.

## Adding a new MCP tool

1. Define the tool schema in `servers/nudge-mcp-server.mjs` (follow existing `TOOL_DEFINITION` pattern).
2. Add it to the `handleToolsList` response.
3. Add the handler function and wire it in `handleToolsCall`.
4. Update `CLAUDE.md` to document when Claude should use the new tool.
5. Add tests to `servers/nudge-mcp-server.test.mjs`.

## Adding a new slash command

1. Create a `.md` file in `commands/`.
2. Front matter: `name` (the command suffix) and `description`.
3. Body: instructions for Claude Code on what to do (run a script, call an MCP tool, etc.).

## Commit conventions

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add WebSocket support for real-time streaming
fix: handle expired token in MCP server
docs: update hook reference table
test: add coverage for nudge-stop.sh cooldown
chore: update CI to Node.js 22
```

## Pull request process

1. Fork the repository and create a feature branch (`feat/...`, `fix/...`).
2. Make your changes. Run the test suite.
3. Submit a PR against `main`.
4. Describe what changed and why. Include test output if relevant.
5. One approval required for merge.

## Reporting issues

Use GitHub Issues. Include:

- Node.js version (`node --version`)
- macOS/Linux version
- Claude Code version
- Steps to reproduce
- Relevant log output from `~/.nudge/nudge.log` or `~/.nudge/hook-debug.log`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
