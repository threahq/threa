---
name: update-pi-remote-plugin
description: Keep the Threa Pi remote-control extension in `extensions/pi-remote/` aligned with the current Pi extension API and Threa bot-runtime public API. Use when asked to update, verify, sync, or troubleshoot the Pi remote plugin, `/remote-control`, or `threa-remote.ts`.
---

# Update Pi remote plugin

The canonical Threa Pi remote adapter currently lives at:

- `extensions/pi-remote/src/threa-remote.ts`
- tests: `extensions/pi-remote/src/threa-remote.test.ts`
- package manifest: `extensions/pi-remote/package.json`

The local install target for real use is typically a package directory:

- `~/.pi/agent/extensions/threa-remote/`

Do not edit the installed copy first. Update the repo copy, verify it, then copy the package directory/install dependencies/reload locally if requested.

## Required context

1. Read repo guidance before changing code:
   - `CLAUDE.md`
   - `~/.claude/CLAUDE.md` if present
2. Read current Pi extension docs/API because Pi changes independently of Threa:
   - `/Users/kristofferremback/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
   - `/Users/kristofferremback/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/docs/packages.md` when changing packaging/dependencies
   - Focus on extension locations, package manifests, `pi.registerCommand(name, options)`, lifecycle events, `ctx.isIdle()`, `ctx.sessionManager`, and `pi.sendUserMessage()`.
3. Check the Threa protocol/API surfaces the plugin depends on:
   - `apps/backend/src/features/public-api/schemas.ts`
   - `apps/backend/src/features/public-api/handlers.ts`
   - `apps/backend/src/routes.ts` around `/bot-runtime/*` and `/bot-invocations/*`
   - `apps/backend/src/features/bot-runtimes/`
   - `packages/types/src/constants.ts` around bot runtime/invocation constants
4. Compare against product intent:
   - `docs/plans/pi-remote-protocol-implementation.md`
   - `docs/plans/interactive-bot-scratchpads.md` only if behavior is unclear

## Update checklist

Verify the adapter still:

- Registers `/remote-control` using the current Pi API: `pi.registerCommand("remote-control", { ... })`.
- Reads config from `~/.pi/agent/threa-remote.json` with required `baseUrl`, `workspaceId`, and `apiKey`.
- Supports `/remote-control configure` so Kris can paste/edit `baseUrl`, `workspaceId`, `apiKey`, `pollMs`, and `defaultDisplayName` from inside Pi.
- Uses a bot API key only; do not add user-key fallback behavior.
- Creates/links sessions through `POST /api/v1/workspaces/:workspaceId/bot-runtime/sessions`.
- Heartbeats through `POST /api/v1/workspaces/:workspaceId/bot-runtime/presence`.
- Uses the `/bot` WebSocket transport via `socket.io-client`, with HTTP polling as the safety backstop.
- Claims through `POST /api/v1/workspaces/:workspaceId/bot-invocations/claim` with current `supportedCapabilities`.
- Renews long-running claims before expiry.
- Advertises `busy` presence while Pi is working locally or on a Threa invocation, not just while claims are being processed.
- Claims messages that arrive while Pi is busy and injects them with Pi steering (`deliverAs: "steer"`) instead of waiting until idle.
- Records trace steps through `/steps` without leaking raw tool args, file contents, shell output, or secrets.
- Completes/fails through `/complete` and `/fail` with `instanceId` + `claimToken`.
- Stores enabled/disabled state per Pi session link, not as a global config flag.
- Stores stream cursors per Pi session link, not as a global cursor map.
- Stops polling and marks presence offline on final `session_shutdown`; reload shutdown should reconnect automatically.
- Does not poll arbitrary stream messages as the work trigger. Threa-owned invocation rows are the trigger.

## Verification

Run the focused test:

```bash
bun test ./extensions/pi-remote/src/threa-remote.test.ts
```

If you changed backend API contracts, also run the relevant backend tests and/or typecheck. At minimum, inspect the route schemas and explain why the plugin request/response shapes still match.

Optional local smoke check when Pi is available:

```bash
rm -f ~/.pi/agent/extensions/threa-remote.ts
rm -rf ~/.pi/agent/extensions/threa-remote
mkdir -p ~/.pi/agent/extensions/threa-remote
cp -R extensions/pi-remote/. ~/.pi/agent/extensions/threa-remote/
cd ~/.pi/agent/extensions/threa-remote && npm install
# In Pi: /reload, then /remote-control status or /remote-control
```
