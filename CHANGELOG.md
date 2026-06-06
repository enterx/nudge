# Changelog

All notable changes to Nudge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-06-06

Adds multi-CLI pairing (M3): a second computer can join a phone that is already paired, sharing the phone's identity and end-to-end encryption key instead of creating a separate account. Fully backwards compatible — the ordinary first-pair flow is unchanged, and older plugins keep working against the updated backend for first-pair.

### Added

- **Multi-CLI pairing** — when `pairVerify` returns `multiCli: true` (the phone rebound the pairing to its existing UID during *pair another computer*), `nudge pair` now adopts the phone's freshly-issued `cliIdToken` / `cliRefreshToken` and unwraps the phone's encryption key via `PBKDF2(pairingCode, mobileUid)`, so every paired device shares one UID and one key. Responses without `multiCli` keep the existing single-CLI behavior. New `crypto.mjs` `unwrapKey()` and `lib/unwrap-key.mjs` helper (built-ins only; sensitive values passed via stdin).

### Fixed

- **Abort incomplete multi-CLI rebinds** — if a `multiCli: true` response is missing `wrappedKey` / `wrappingIv`, `nudge pair` now fails loudly instead of silently writing an isolated pairing (own UID + locally-generated key) that the phone could never reach. Surfaces a broken server rebind at pair time rather than at the first failed `approve`.

## [1.2.0] - 2026-05-22

CLI-side minor release. Adds two differentiating features. No backend changes required for the CLI to work; mobile UI for attachment rendering ships in a separate release.

### Added

- **`nudge run -- <cmd> [args...]`** — wrap a child command, stream its stdio through, and notify on exit with exit code, duration, and the last N lines of output. Drop-in wrap: the child's exit code propagates so `nudge run -- make test` is interchangeable with `make test`. Flags: `--on success|fail|always`, `--tail N`, `--title T`, `--ask` (use approve flow instead of notify), `--context C`, `--session N`.
- **`--image <path>` / `--file <path>`** (repeatable) on `ask`/`approve`/`notify` — attach an image or file (≤ 2MB per file) inlined into the encrypted payload. Mime is auto-detected from the extension. Attachments live in the encrypted inner JSON as `attachments: [{ filename, mime, sizeBytes, sha256, dataBase64 }]` so mobile decrypts and renders on-device. Larger files will eventually go via Storage; the 2MB ceiling enforces the inline-only path for now.

## [1.1.0] - 2026-05-21

Minor release rolling up the cleanup pass and the feature additions that landed between 1.0.2 and now. CLI-side only — no backend or mobile-app changes required for any of this to be usable (richer features light up incrementally as mobile/backend catch up).

### Added

- **`nudge cancel`** — stop in-flight mobile events from another process: `nudge cancel <event-id>` / `--session <name>` / `--last` / `--all`. Useful in CI cleanup traps, supervisor scripts, or when handling an approval from a different terminal than the one that started it. Backend-agnostic — uses the existing `/eventsRespond/:id/respond` endpoint.
- **`--ttl <seconds>`** on `ask`/`approve` — give up waiting after N seconds. Exit code **6** (TIMEOUT). The mobile event is best-effort cancelled so the pending card dismisses. Server-side TTL enforcement (auto-cancel of expired events) lands in a future backend release; the CLI carries `ttl` on the `eventsCreate` payload so that path activates automatically when ready.
- **`--text`** on `nudge ask` — accept free-form text answers without requiring 2–4 curated options. The payload signals `textOnly: true` so mobile can render a text input UI when it picks the field up.
- **`--action key:label[:description]`** on `nudge ask`/`approve` (repeatable) — follow-up action buttons distinct from `-o` choices. The user's pick comes back as `selectedAction` so an agent reading `--json` can branch ("user asked me to /verify first instead of approving"). For `approve`, a follow-up action exits **1** — same as deny — so shell chains stay safe.
- **Structured context flags** carried inside the encrypted payload: `--diff <path>`, `--files a,b,c`, `--exit-code N`, `--tool-name S`. Cleaner than stuffing `--context "$(git diff)"`. Applies to `ask`, `approve`, and `notify`.
- **`NUDGE_JSON_VERSION=2`** opts into a unified JSON envelope across every command: `{ ok, command, data }` on success and `{ ok, command, error: { code, message } }` on failure. Error codes: `USAGE`, `NOT_PAIRED`, `NETWORK`, `VALIDATION`, `CANCELLED`, `TIMEOUT`, `ERROR`. In v2, errors go to **stdout** (not stderr) so a single parse covers both paths. v1 (per-command ad-hoc shape) remains the default until v2.0.

### Changed

- **`nudge mode <target>`** is deprecated. It now prints a stderr warning and forwards to `nudge status --mode <target>`. Scheduled for removal in v1.3.
- **`nudge approve`** no longer parses the undocumented `--title` / `--tool` / `--input` / `--cwd` flags on the CLI; passing them prints a warning and ignores them. MCP integrations are unaffected (the handler signature still accepts these fields).
- **Shared modules**: `core/lib/pending-files.mjs` (in-flight event tracking) and `core/lib/hook-runtime.mjs` (encryption envelope + payload builder) are now shared between the CLI handlers and the Claude Code hook adapter, eliminating two near-identical copies that had drifted on minor field choices.
- **Pending file format**: persists `sessionId` (and optional `sessionName`) in the JSON body so cross-session lookup doesn't require parsing filenames. Pre-1.2 files written by the hook adapter remain readable via a filename-prefix fallback.

### Fixed

- `nudge cancel --all` correctly removes local `~/.nudge/pending-*.json` for events written by the Claude Code hook adapter before v1.2 (where the filename's last-dash heuristic mis-derived sessionId for Firebase-style eventIds whose first character is `-`).
- `--ttl N` total wall time is now close to N (previously N + up to 5s) because the post-timeout best-effort backend cancel uses a tight 1.5s budget instead of inheriting the default 5s SIGINT-cleanup budget.

## [1.0.1] - 2026-05-19

### Changed

- **Session ID**: drop the `session-` prefix from auto-generated session IDs so the mobile app can render a clean fallback title. Existing host-provided IDs are passed through unchanged.
- **Same-terminal grouping**: `getSessionId()` now reads `TERM_SESSION_ID` (set by macOS Terminal and iTerm) and returns `term-<id>`, so multiple `nudge` invocations from the same terminal tab share a single session. Random fallback UUIDs are now persisted to a per-parent file so subsequent calls within the same shell process tree reuse the same ID.
- **Provider auto-detect**: `nudge ask`/`approve`/`notify` infer the host (claude-code, codex, cursor, windsurf, github-actions, gitlab-ci, circleci, buildkite, jenkins, ci) from environment variables and the parent process. When detection fails, the `provider` field is omitted so the mobile app no longer shows a wrong default.

### Packaging

- npm package now ships only the CLI surface (`core/nudge-cli.mjs`, `core/lib/`, `core/lib.sh`, `core/nudge-pair.sh`). The MCP server and hook scripts live in the plugin adapters and are not part of the published npm package.

## [1.0.0] - 2026-03-21

### Added

- **Monorepo structure**: `core/` shared code + `adapters/` per-tool configuration. `build.sh` assembles self-contained `dist/` package.
- **PermissionRequest hook** (`nudge-hook.mjs`): Intercepts Bash, Write, Edit, NotebookEdit permission prompts and sends them to your phone for approval/denial via push notification. Supports "always allow" to persist permission rules.
- **PostToolUse / PostToolUseFailure hooks** (`nudge-cancel-pending.mjs`): Resolves orphaned mobile events after tool completion or failure.
- **PreToolUse hook** (`nudge-activity.mjs`): Sends lightweight activity notifications for WebSearch/WebFetch calls.
- **MCP server** with three tools:
  - `nudge_ask_user`: Send questions with selectable options to the user's phone.
  - `nudge_approve`: Send approval requests (Approve/Deny) to the user's phone.
  - `nudge_notify`: Send one-way status notifications (fire-and-forget).
- **Skills**: `/nudge-pair`, `/nudge-test`, `/nudge-status`, `/nudge-afk`, `/nudge-desk`.
- **End-to-end encryption**: AES-256-GCM encryption with PBKDF2 key wrapping during pairing. Zero-knowledge server design.
- **`SECURITY.md`**: Vulnerability reporting policy and security design documentation.
- **Privacy & data handling** section in README.
- **Input length validation** on all MCP tools (4000 character limit per string field).
- Automatic JWT token refresh with 5-minute expiry buffer.
- SSE streaming via Firebase RTDB for real-time responses.
- Graceful degradation: all failures exit 0 so the coding AI falls back to terminal prompts.
- Secret redaction in tool inputs (Bearer tokens, AWS keys, GitHub tokens).
- Cooldown logic to prevent duplicate notifications across hooks.
- MCP server test suite, config tests, SSE tests, and bash test suite.
- Zero runtime dependencies: Node.js built-ins and bash only.
