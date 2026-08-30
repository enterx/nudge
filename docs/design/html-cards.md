# Design: HTML cards — render (and later, answer with) HTML on the phone

Status: draft / Owner: rayuron / 2026-06-13

## Where we already are

The transport already carries HTML: `text/html` is registered in the MIME
table (`core/lib/attachments.mjs:37`) and ships inline base64, E2E-encrypted,
up to 2 MB (`attachments.mjs:20`). What's missing is only the mobile renderer.

## App Store review analysis

Verdict: **low risk**, with implementation discipline.

- Guideline 2.5.2 / Developer Agreement 3.3.1B explicitly **permit code
  executed by WebKit / JavaScriptCore**. Rendering user-supplied HTML in a
  sandboxed WKWebView is the same posture as mail clients, RSS readers, and
  dev tools (Working Copy, Koder) that passed review for years.
- Guideline 4.7 (HTML5 mini-apps) targets *distributing third-party apps*.
  Nudge renders the user's **own content, from their own paired machine,
  E2E-encrypted** — review narrative is "document preview", not "platform".
- The real review (and security) risk is native-bridge exposure, mitigated
  below.

## Phase 1 — static preview (mobile only)

WKWebView hardening spec:

- `loadHTMLString(_:baseURL: nil)`; `allowFileAccessFromFileURLs` off.
- **No script message handlers** in Phase 1.
- Inject CSP via meta rewrite: `default-src 'none'; img-src data:;
  style-src 'unsafe-inline'; script-src 'unsafe-inline'` — JS may run but
  cannot reach the network or local files.
- Navigation policy: any non-initial navigation → cancel and open in
  `SFSafariViewController`.
- Render as an expandable card in the event detail, like image attachments.

## Phase 2 — interactive cards (answer from HTML)

The payoff: an `ask` whose UI is generated HTML (forms, sliders, diff
pickers). One constrained bridge, only on ask-type events:

```js
window.webkit.messageHandlers.nudgeAnswer.postMessage(
  { value: "optA" } /* or { freeText: "..." } */
)
```

- Maps 1:1 onto the existing decision flow (`selectedOptions` / `freeText` in
  `runAsk`, `core/lib/handlers.mjs:303`). No new backend semantics.
- Bridge accepts exactly one message, then detaches; schema-validated;
  payload size-capped. Still inside the WebKit carve-out.

## CLI work

- `--html <path>`: single-file bundler — inline local `<link>`/`<script
  src>`/`<img>` into the document, fail with a clear error above 2 MB.
  (Equivalent to `--file page.html` today, plus inlining + mime pinning.)
- Larger payloads wait for the signed-URL Storage attachment path already
  promised in `attachments.mjs:75`.

## Sequencing

Phase 1 needs zero CLI/backend change — pure mobile work, immediately useful
for UI screenshots-as-HTML, reports, diffs. Phase 2 after the answer-bridge
schema is settled.
