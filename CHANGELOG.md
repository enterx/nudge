# Changelog

All notable changes to Nudge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-03-14

### Added

- **`SECURITY.md`**: Vulnerability reporting policy and security design documentation.
- **Privacy & data handling** section in README: Documents what data is sent, stored, and how long it is retained.
- **Disclaimer** in README: Clarifies non-affiliation with Anthropic, Google, and Firebase.
- **Input length validation** on all MCP tools (4000 character limit per string field).
- **`.gitignore`**: Comprehensive ignore rules for OS files, IDE configs, secrets, `node_modules`, and `dist/`.

### Changed

- Log directory (`~/.nudge/`) now created with `0o700` permissions; log files with `0o600`.
- `unhandledRejection` handler redacts tokens and credentials from stderr output.
- API error responses truncated to 200 characters to prevent server info leakage.
- Cancellation logic simplified: dual `responded`/`signalHandled` flags replaced with single `cancelled` guard.
- MCP server: config/token acquisition deduplicated into `getAuthContext()` helper.
- MCP server: in-flight request tracking deduplicated into `waitWithTracking()` helper.
- MCP server: tool handler dispatch changed from if/else chain to map lookup.
- `nudge-notify.sh`: JSON construction now uses `jq` when available; fallback escapes quotes.
- `nudge-activity.mjs`: Removed verbose stderr debug output visible to users.
- `LAST_NOTIFY_PATH` now uses `NUDGE_CONFIG_DIR` for env override consistency.
- Fixed variable shadowing in `api.mjs` (parameter `body` vs error variable).
- Removed unused imports (`existsSync`) and variables (`sessionId`, `cwd` in activity hook).
- Updated `commands/` references to `skills/` across docs.
- `dist/` removed from version control (build output).

### Fixed

- `nudge-pair.sh`: Removed unnecessary token check before config reset.

## [2.0.0] - 2026-02-23

### Added

- **Monorepo structure**: `core/` shared code + `adapters/` per-tool configuration. `build.sh` assembles self-contained `dist/` package.
- **`nudge-notify.sh`**: Notification hook handler with cooldown, ask-mode filtering, and recent-approval suppression.
- **MCP server test suite** (`nudge-mcp-server.test.mjs`): 18 tests covering initialization, tool validation, and error handling.

### Changed

- Repository restructured from flat plugin directory to monorepo with `core/`, `adapters/`, and `dist/`.
- Tests moved from `scripts/` to `tests/` directory.

## [1.0.0] - 2026-02-22

### Added

- **PermissionRequest hook** (`nudge-hook.mjs`): Intercepts Bash, Write, Edit, NotebookEdit permission prompts and sends them to your phone for approval/denial via push notification. Supports "always allow" to persist permission rules.
- **SessionStart hook** (`nudge-session-start.sh`): Injects ask-mode context (nudge or terminal) into the Claude Code session.
- **SessionEnd hook** (`nudge-session-end.sh`): Sends a push notification when the session ends.
- **PreToolUse hook** (`nudge-activity.mjs`): Sends lightweight activity notifications for WebSearch/WebFetch calls.
- **MCP server** with three tools:
  - `nudge_ask_user`: Send questions with selectable options to the user's phone.
  - `nudge_approve`: Send approval requests (Approve/Deny) to the user's phone.
  - `nudge_notify`: Send one-way status notifications (fire-and-forget).
- **Slash commands**: `/nudge:pair`, `/nudge:test`, `/nudge:status`, `/nudge:mode`, `/nudge:afk`, `/nudge:desk`.
- Automatic JWT token refresh with 5-minute expiry buffer.
- SSE streaming via Firebase RTDB for real-time responses.
- Graceful degradation: all failures exit 0 so the AI tool falls back to terminal prompts.
- Secret redaction in tool inputs (Bearer tokens, AWS keys, GitHub tokens).
- Cooldown logic to prevent duplicate notifications across hooks.
- Bash test suite (`nudge-scripts.test.sh`) covering lib.sh and shell hook scripts.
- Zero runtime dependencies: Node.js built-ins and bash only.
