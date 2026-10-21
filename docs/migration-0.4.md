# Upgrading to 0.4

[简体中文](zh-CN/migration-0.4.md)

0.4 changes runtime requirements and two defaults. Existing explicit browser environment settings remain opt-in.

## Runtime

Use Node.js **24.22.0 or newer** for the installed package, source development and tests. Update CI images and the Node executable used by your Agent host before upgrading. Bun-specific implementations and scripts have been removed; Bun is no longer a supported runtime. Install with npm and use the standard ESM exports.

## Headless User-Agent

`maskHeadless` now defaults to `false`. Headless Chrome keeps its native UA and Client Hints. To retain the previous masking behavior, explicitly pass `maskHeadless: true`; this is a compatibility choice, not a recommendation. Measurements found that masking can make page/Dedicated Worker values differ from Shared/Service Workers. See the [differential audit](differential-audit.md).

No language is forced by default. `zh-CN`, `en-US` and other preferences are valid; HTTP fallback ranges need not literally equal `navigator.languages`. The [Worker startup experiment](worker-environment.md) records configuration scope and differences without treating language choices as automation indicators. Its paused-target and Locale strategies remain experiments, not production defaults.

## Reproducible input

An input behavior gets a random seed once when no seed is supplied. Tests that relied on the old implicit seed `1` must supply `seed: 1` explicitly. Reconfiguring without a seed preserves the current random stream; supplying a seed resets it. Reports include the initial seed and action-start state. See [input behavior](input.md) for configuration and replay limits.

## Agent clients

The default MCP entry point still requires **2026-07-28**. For clients using **2025-11-25** or **2025-06-18**, enable `--mcp-compat`: stdio negotiates those versions, and HTTP exposes the separate `/mcp/compat` route. The modern `/mcp` route stays strict. Browser permissions, queues and application leases are shared; no core downgrade is needed. Human confirmation requires the client's corresponding capability and otherwise fails explicitly.

See [Agent compatibility](agent-compatibility.md) and [Pi verification](pi.md) for complete setup and the boundary between verified wire operations and manual/TUI acceptance.

## Validation boundaries

The release uses stable Windows/Linux regression and minimum Node.js acceptance. Beta/Dev/Canary probes provide additional warnings, not a promise that every API works on every preview. Physical input, real human handoff and a current full platform matrix remain separate acceptance work. Historical platform records in [support](support.md) are identified by version and should not be read as a new certification.
