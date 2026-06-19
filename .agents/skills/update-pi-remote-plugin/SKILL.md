---
name: update-pi-remote-plugin
description: Keep the Threa Pi remote-control extension in `extensions/pi-remote/` aligned with the current Pi extension API and Threa bot-runtime public API. Use when asked to update, verify, sync, or troubleshoot the Pi remote plugin, `/remote-control`, or `threa-remote.ts`.
---

# Update Pi remote plugin

The canonical Threa Pi remote adapter currently lives at:

- `extensions/pi-remote/src/threa-remote.ts` — the adapter
- `extensions/pi-remote/src/crypto.ts` — **vendored** subset of `@threa/crypto` for the sealed (E2E) path
- tests: `extensions/pi-remote/src/threa-remote.test.ts`, `threa-remote.sealed.test.ts`, `crypto.parity.test.ts`
- package manifest + lockfile: `extensions/pi-remote/package.json`, `extensions/pi-remote/bun.lock`

The local install target for real use is typically a package directory:

- `~/.pi/agent/extensions/threa-remote/`

Do not edit the installed copy first. Update the repo copy, verify it, then copy the package directory/install dependencies/reload locally if requested.

This extension is **self-contained**, not a Bun workspace member (like its sibling `extensions/claude-code-remote`). It declares its own `dependencies` (`socket.io-client`, `@hpke/core`, `@hpke/dhkem-x25519`, `ulid`) and commits its own `bun.lock`, because at the user's machine it is installed standalone (copied, then deps installed per the extension README) where the private `@threa/*` workspace packages don't resolve. In-repo, run `bun install` from `extensions/pi-remote/` after changing deps. It has **no typecheck script** — `threa-remote.ts` imports types from the global `@earendil-works/pi-coding-agent`, which isn't an installed dependency, so `tsc` can't resolve it in-repo (`bun test` runs fine because type-only imports are erased).

## Sealed (E2E) external-bot path

The harness can serve an end-to-end-encrypted scratchpad: when the owner has invited the bot as an E2E actor and the `externalSealedDelivery` policy is on, a winning claim carries a `sealedContext` (`SealedTurnContext`) instead of the plaintext `context`. Design: `docs/plans/agent-runtimes-unification-redesign.md` §2.6 (binding forward-compat rules). The enclave (`apps/enclave/`) is the reference sealed runner.

- **BIK (Bot Identity Key):** a per-install X25519 keypair persisted at `~/.pi/agent/threa-remote-bik.json` (mode 0600), generated lazily by `ensureBik()`. Its `publicKey`/`publicKeyId` ride **every** `bot:hello` AND HTTP presence write — the backend overwrites the BIK on a presence write that omits it, so a heartbeat without it would clear what `bot:hello` registered.
- **Vendored crypto:** `crypto.ts` is a faithful copy of `packages/crypto`'s `{encoding,hpke,stream-key,envelope,sealed-payload}` subset. It uses the **noble** X25519 KEM (`@hpke/dhkem-x25519`), NOT `@hpke/core`'s native KEM — Bun's WebCrypto lacks X25519 `deriveBits`, so native encap/decap throw there; noble works in any runtime and is RFC-9180-interoperable with the owner's native KEM. `crypto.parity.test.ts` asserts byte-parity against the canonical `@threa/crypto` (relative import) — keep them in sync; if the canonical AAD layout or envelope version changes, mirror it here or the owner can't open the bot's sealed replies.
- **Wire:** unwrap the SSK from `sealedContext.wraps` (AAD `buildWrapAad`, recipient = BIK id, stream id = `rootStreamId`); open the trigger/history; seal replies/steps under the SSK with `buildMessageAad({ streamId: rootStreamId, messageId|stepId, senderId: reply.senderId })`. Sealed callbacks authorize with the `X-Threa-Callback-Token` header (the claim's `callbackToken`), NOT body `instanceId`/`claimToken`. Steps POST to `/sealed-steps`, completion to `/sealed-complete`; `/renew` and `/fail` are shared (they auth by claim token, which a sealed claim still returns). Attachments aren't shipped on the sealed path yet — completion strips `THREA_ATTACH:` directives rather than uploading plaintext to S3.
- **Trace detail (sealed = full, plaintext = redacted):** `shouldEmitFullTrace(invocation)` gates whether tool args/output ride the trace in full. On a sealed turn the step content is ciphertext the server can't read, so the harness sends the real command/patch/output (`fullToolArgumentSummary`, full result body) — more useful to the owner, nothing gained by the server. A plaintext turn ALWAYS redacts (`safeToolArgumentSummary`, `summarizeToolOutput`) because the server sees it in the clear. The `config.sealedFullTrace` toggle (default `true`) only lets a user opt a sealed turn back to redacted; it can't enable full detail on plaintext. The trace-formatting safety tests in `threa-remote.test.ts` cover both branches — keep them when touching `formatToolCallTrace`/`formatToolResultTrace`.

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
   - `apps/backend/src/features/bot-runtimes/` (incl. the `bot:hello` socket handler + BIK fields)
   - `packages/types/src/constants.ts` around bot runtime/invocation constants (`THREA_CALLBACK_TOKEN_HEADER`)
   - For the sealed path: `apps/backend/src/features/public-api/sealed-turn-context.ts`, the `SealedTurnContext`/`SealedReply`/`SealedStep`/`SealedComplete` types in `packages/types/src/api.ts`, and `packages/crypto/src/` (the source of truth the vendored `crypto.ts` mirrors)
4. Compare against product intent:
   - `docs/plans/agent-runtimes-unification-redesign.md` §2.6 for the sealed (E2E) external-bot rules
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

For the sealed (E2E) path, also verify:

- Registers the BIK (`publicKey`/`publicKeyId`) on `bot:hello` and on every HTTP presence write (never let a heartbeat clear it).
- Detects `sealedContext` on a claim and routes through the sealed wire (decrypt trigger/history, seal replies/steps, `/sealed-steps` + `/sealed-complete` with the `X-Threa-Callback-Token` header) instead of the plaintext endpoints.
- Never sends decrypted content to a plaintext endpoint, a cleartext field, or an error/`statusText` string on a sealed turn.
- Keeps `crypto.ts` byte-compatible with `@threa/crypto` (the parity test must pass) and on the noble KEM.

## Verification

Run the suite from the extension directory (it resolves the standalone `node_modules`):

```bash
cd extensions/pi-remote && bun test
```

This covers the adapter, the sealed-path behavior, and the `crypto.parity.test.ts` drift guard against `@threa/crypto`. If you changed backend API contracts, also run the relevant backend tests and/or typecheck. At minimum, inspect the route schemas and explain why the plugin request/response shapes still match.

Optional local smoke check when Pi is available:

```bash
rm -f ~/.pi/agent/extensions/threa-remote.ts
rm -rf ~/.pi/agent/extensions/threa-remote
mkdir -p ~/.pi/agent/extensions/threa-remote
cp -R extensions/pi-remote/. ~/.pi/agent/extensions/threa-remote/
cd ~/.pi/agent/extensions/threa-remote && npm install
# In Pi: /reload, then /remote-control status or /remote-control
```
