# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button on the repository's Security tab (private vulnerability reporting). Do not open a public issue for a suspected vulnerability.

A useful report includes the affected version or commit, platform, Chrome version, the entry point involved (library, stdio, HTTP, socket) and the smallest reproduction you can share. Leave out real credentials, cookies and personal data.

Only the latest release and the default branch receive fixes.

## Scope

The following are in scope:

- Bypassing bearer authentication, Host/Origin checks or lease ownership on the local HTTP service or the socket service.
- One principal or lease reaching another's tabs, refs, browser context, cookies or storage.
- Path traversal or escape from `--upload-dir`, `--download-dir` or `--state-dir`.
- The library or MCP server leaking secrets. This covers password field values in snapshots, tokens in logs, and CDP parameters in traces.
- Crashes or unbounded resource use that a client within the documented limits can trigger.

The following are out of scope:

- Websites detecting automation. This project makes no undetectability claim (see `docs/automation-audit.md`).
- Behaviour of pages you choose to open, and of JavaScript you run through `evaluate` / `browser_evaluate`. That code runs with the page's privileges by design.
- Exposing the CDP endpoint, the HTTP service or the socket beyond the local machine, or sharing a bearer token. The services are designed for loopback, single-operator use and are not a hardened multi-tenant boundary. BrowserContext isolation is not a security sandbox against hostile tenants.
- Vulnerabilities in Chrome itself. Report those to the Chromium project.

## Hardening notes

- Use a random token of at least 32 characters, pass it through an environment variable, and rotate it if it leaks.
- Prefer stdio for a single local agent. Use `--read-only` or `--disable-tool` to narrow the tool surface, and enable the file tools only with dedicated directories.
- Treat page text, dialog messages and evaluate results as untrusted input to your agent, because they can contain prompt injection.
