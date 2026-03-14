# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Nudge, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email: **security@enterx.io**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

This policy covers the open-source Nudge plugin code in this repository. The Nudge backend server is not part of this repository.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| 1.x     | No        |

## Security Design

- **Zero npm dependencies**: Reduces supply chain attack surface.
- **Credential storage**: Config file at `~/.nudge/config` with `chmod 600`. Directory at `~/.nudge/` with `chmod 700`.
- **Secret redaction**: Tokens, API keys, and credentials are automatically redacted from logs, error messages, and mobile-visible fields.
- **HTTPS only**: All API communication uses TLS.
- **Graceful degradation**: All hooks exit 0 on failure, preventing the plugin from blocking the host tool.
- **Token refresh**: Firebase ID tokens auto-refresh with a 5-minute expiry buffer.

## Known Limitations

- Firebase RTDB SSE streaming passes the auth token as a URL query parameter (`?auth=...`). This is the standard Firebase RTDB REST API pattern. The token is redacted from all error messages and logs.
- The plugin does not verify the TLS certificate chain beyond Node.js/curl defaults.
