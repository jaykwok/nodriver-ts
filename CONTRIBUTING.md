# Contributing

Thanks for helping. Issues and pull requests are welcome in English or Chinese.

## Ground rules

These are project invariants. Pull requests that break them will not be merged.

- **Never send `Runtime.enable`, `Runtime.disable`, `Runtime.addBinding`, `Console.enable` or `Debugger.enable` automatically**, and never fall back to them. The wire-audit tests (`test/fixtures/wire.ts`) enforce this.
- **Never disable Chrome's sandbox or site isolation**, and never add `--no-sandbox` on the user's behalf.
- **Never replay input or actions.** After a click, typing or a navigation has been dispatched, report the failure and do not retry it.
- **Do not spoof the environment by default.** Overrides such as UA, client hints, timezone and viewport must stay explicit opt-ins. The headless UA mask is the only default, and it can be turned off.
- **MCP stays on protocol 2026-07-28 only.** Do not add legacy `initialize` support.
- **Never publish private or local artefacts.** IP addresses, fingerprints, local paths, tokens and raw detector output stay in the git-ignored `dev/` and `docs/dev/` directories.

## Setup

```sh
bun install --frozen-lockfile
bun run check           # tsc, strict, for src and tests
bun run test            # unit tests, no browser needed
bun run test:integration  # needs a local Chrome; set NODRIVER_HEADFUL=1 to watch it
bun run test:node       # build plus a Node.js smoke test
bun run format          # prettier
```

Integration tests launch real Chrome over both the pipe and WebSocket transports. On a machine without a display they run headless by default; set `CHROME_PATH` to choose the binary.

## Pull requests

- Keep changes focused, and add or adjust tests next to the behaviour you change. Unit tests go in `test/unit`; anything that needs Chrome goes in `test/integration`.
- New CDP usage must pass the forbidden-command wire audit. If a feature needs a domain, enable it lazily, scope it to the session that needs it, and document why.
- Public API changes need a short entry in `CHANGELOG.md` and an update to `docs/api.md` or the MCP docs.
- Match the existing style: strict TypeScript, no `any` in `src` without a reason, and comments only where the reason is not obvious.
- By contributing you agree that your contribution is licensed under AGPL-3.0-or-later.
