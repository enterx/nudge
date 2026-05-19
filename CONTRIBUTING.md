# Contributing to Nudge

Thank you for your interest in contributing. This document covers the setup, conventions, and process for submitting changes.

## Philosophy

- **Zero npm dependencies.** Node.js built-ins only (`fs`, `path`, `os`, `readline`, `child_process`). If Node.js ships it, use it. Otherwise, implement it yourself.
- **Graceful degradation.** Every hook exits 0 on failure. The host AI tool must never get stuck because of Nudge.
- **No `jq` requirement in JavaScript.** Bash scripts may use `jq` when available but must provide a grep/sed fallback. Node.js scripts use `JSON.parse`.
- **Bash portability.** Target bash 3.2+ (macOS default). Use POSIX-compatible constructs where possible.

## Prerequisites

- Node.js 18+ (for built-in `fetch`)
- bash 3.2+
- A coding AI with plugin/hook support (e.g., [Claude Code](https://docs.anthropic.com/en/docs/claude-code))
- [shellcheck](https://github.com/koalaman/shellcheck) (optional, for linting bash scripts)

## Dev setup

1. Clone the repository:

```bash
git clone https://github.com/enterx/nudge-plugin.git
cd nudge-plugin
```

2. Load the plugin in Claude Code:

```
/plugin marketplace add /path/to/nudge-plugin
/plugin install nudge
```

For development, rebuild after making changes to `core/` or `adapters/`:

```bash
bash build.sh
```

3. Make changes, rebuild, then restart Claude Code to pick up hook/MCP changes.

For rapid iteration on scripts that do not affect hooks registration or MCP server startup, you can test them directly:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node adapters/claude-code/scripts/nudge-hook.mjs
```

## Project structure

```
nudge-plugin/
├── core/                       # Shared code (source of truth)
│   ├── lib/                    # Node.js modules (api, config, sse, crypto, etc.)
│   ├── lib.sh                  # Shared bash utilities
│   ├── nudge-mcp-server.mjs    # MCP server (3 tools)
│   ├── nudge-*.sh              # Shared scripts (pair, mode, status, notify)
│   └── tests/                  # Test suite
├── adapters/
│   └── claude-code/            # Claude Code adapter
│       ├── hooks/hooks.json    # Hook registration
│       ├── .mcp.json           # MCP server registration
│       ├── CLAUDE.md           # Context instructions
│       ├── skills/             # Skill definitions
│       └── scripts/            # Hook scripts (hook, activity, session)
├── build.sh                    # Assembles dist/ from core + adapters
└── dist/
    └── claude-code/            # Build output (self-contained, installable)
```

### Key files

- **`core/lib.sh`**: Every bash script sources this. It provides `config_read`, `config_write`, `api_post`, `api_get`, `json_extract`, `graceful_exit`, and token management.
- **`adapters/claude-code/scripts/nudge-hook.mjs`**: The core PermissionRequest handler. Reads stdin (hook input JSON), posts to the Nudge API, waits for SSE response, outputs an allow/deny decision.
- **`core/nudge-mcp-server.mjs`**: JSON-RPC 2.0 over stdio. Implements `nudge_ask_user`, `nudge_approve`, `nudge_notify`.

## Running tests

```bash
bash build.sh
cd dist/claude-code/plugins/nudge && bash tests/run-all.sh
```

The test suite covers Node.js unit tests, MCP server tests, and shell script tests -- no live server required. Use `/test-nudge` in a live session for end-to-end verification.

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

1. Write the script in `core/` (shared) or `adapters/claude-code/scripts/` (adapter-specific).
2. Register it in `adapters/claude-code/hooks/hooks.json` under the appropriate event.
3. Set `timeout` appropriately:
   - Sync hooks (blocking): keep it short (5-30s). Use 86400 for PermissionRequest (user may be AFK).
   - Async hooks (fire-and-forget): 10-30s is typical.
4. Decide on `async: true` (non-blocking) or omit for sync (blocking).
5. Test with `echo '<json>' | bash core/your-script.sh` or `| node adapters/claude-code/scripts/your-script.mjs`.
6. Add tests to `core/tests/`.

## Adding a new MCP tool

1. Define the tool schema in `core/nudge-mcp-server.mjs` (follow existing `TOOL_DEFINITION` pattern).
2. Add it to the `handleToolsList` response.
3. Add the handler function and wire it in `handleToolsCall`.
4. Update `adapters/claude-code/CLAUDE.md` to document when Claude should use the new tool.
5. Add tests to `core/tests/`.

## Adding a new skill

1. Create a subdirectory in `adapters/claude-code/skills/` (e.g., `skills/my-skill/`).
2. Add a `SKILL.md` file with front matter: `name` (the skill suffix) and `description`.
3. Body: instructions for the AI tool on what to do (run a script, call an MCP tool, etc.).

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
- AI tool name and version (e.g., Claude Code)
- Steps to reproduce
- Relevant log output from `~/.nudge/nudge.log` or `~/.nudge/mcp-debug.log`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
