# Changelog

All notable changes to Nudge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-21

### Added

- **Monorepo structure**: `core/` shared code + `adapters/` per-tool configuration. `build.sh` assembles self-contained `dist/` package.
- **PermissionRequest hook** (`nudge-hook.mjs`): Intercepts Bash, Write, Edit, NotebookEdit permission prompts and sends them to your phone for approval/denial via push notification. Supports "always allow" to persist permission rules.
- **PostToolUse / PostToolUseFailure hooks** (`nudge-cancel-pending.mjs`): Resolves orphaned mobile events after tool completion or failure.
- **SessionStart hook** (`nudge-session-start.sh`): Injects ask-mode context (nudge or terminal) into the Claude Code session.
- **SessionEnd hook** (`nudge-session-end.sh`): Cancels pending events and cleans up session files.
- **PreToolUse hook** (`nudge-activity.mjs`): Sends lightweight activity notifications for WebSearch/WebFetch calls.
- **MCP server** with three tools:
  - `nudge_ask_user`: Send questions with selectable options to the user's phone.
  - `nudge_approve`: Send approval requests (Approve/Deny) to the user's phone.
  - `nudge_notify`: Send one-way status notifications (fire-and-forget).
- **Skills**: `/nudge:pair`, `/nudge:test`, `/nudge:status`, `/nudge:afk`, `/nudge:desk`.
- **End-to-end encryption**: AES-256-GCM encryption with PBKDF2 key wrapping during pairing. Zero-knowledge server design.
- **`SECURITY.md`**: Vulnerability reporting policy and security design documentation.
- **Privacy & data handling** section in README.
- **Input length validation** on all MCP tools (4000 character limit per string field).
- Automatic JWT token refresh with 5-minute expiry buffer.
- SSE streaming via Firebase RTDB for real-time responses.
- Graceful degradation: all failures exit 0 so the AI tool falls back to terminal prompts.
- Secret redaction in tool inputs (Bearer tokens, AWS keys, GitHub tokens).
- Cooldown logic to prevent duplicate notifications across hooks.
- MCP server test suite, config tests, SSE tests, and bash test suite.
- Zero runtime dependencies: Node.js built-ins and bash only.
