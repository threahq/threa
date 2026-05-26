# Bot Runtime WebSocket Revamp — Plan

> **Scope:** Backend-only. Client-side adoption (bot SDK / Pi runtime) is a follow-up. Backwards-compatible: every existing polling bot keeps working unchanged.

## 1. Problem

The current bot scratchpad invocation framework is **pull-based**. A bot instance discovers work by repeatedly issuing `POST /api/v1/workspaces/:id/bot-invocations/claim`. Each call is a Cloudflare Worker invocation (via `apps/workspace-router`) + a KV lookup + a backend hit, even when the answer is "nothing to do." With one bot per workspace polling every 2–3 seconds at idle, the worker quota is the binding constraint — we've already burnt 50 % of the daily free tier with one user.

Bots also poll `GET /streams/:id/messages` to discover follow-up turns mid-session, and POST `/bot-runtime/presence` on a heartbeat cadence. Each of those is another worker invocation per cycle.

**Why WS solves this:** WebSocket connections bypass the worker entirely (`docs/system-overview.md:54-57`). The frontend already uses `wss://ws-eu.threa.io` direct to the regional backend after fetching `/api/workspaces/:id/config` once. The upgrade itself crosses the worker once and counts as one request; frames thereafter do not. So a bot that opens one long-lived WS instead of polling every 2 s drops from ~1800 worker requests/hour to ~1 (plus whatever HTTP writes it makes).

## 2. Goals & Non-Goals

**Goals**

1. Eliminate the steady-state claim-polling loop. Bots should learn about new work via push, not poll.
2. Eliminate the steady-state presence heartbeat. WS connection IS the presence signal.
3. Keep every persistence path on HTTP — claim, renew, complete, fail, steps, message send, attachment upload, reaction, presence-with-public-key-rotation.
4. Ship without breaking the existing HTTP-only bot. Old clients continue to work; new clients opt in.
5. Survive disconnect / reconnect cleanly. No lost work, no double-claim, no leaked locks.
6. Co-exist with the E2E encryption design (PR #621) without future rework.

**Non-Goals (v1)**

- No bot client SDK changes in this PR. Backend is additive; client adoption is a follow-up.
- No new infrastructure (no separate WS service, no Redis adapter swap — we already run `@socket.io/postgres-adapter`).
- No replacement of the outbox pattern. The new layer rides on top of it.
- No streaming of partial AI output to the user via WS — `agent_session:progress` already does that through the user namespace, unchanged.

## 3. Today's Wiring (Reference)

- **Invocation creation**: `apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts:113-189` — when an outbox `message:created` event fires, the handler scans for `@mentions` and active-scratchpad targets, then calls `BotRuntimeService.createInvocation()` which inserts a `bot_invocations` row.
- **Claim loop**: `POST /api/v1/workspaces/:id/bot-invocations/claim` (`apps/backend/src/features/public-api/routes.ts:546-554`) → `BotInvocationRepository.claimOne()` (`apps/backend/src/features/bot-runtimes/repository.ts:443-482`) uses `FOR UPDATE SKIP LOCKED` to atomically claim one pending row.
- **Socket.IO**: default namespace registered in `apps/backend/src/socket.ts:72-396`. Cookie-auth via `createSocketAuthMiddleware` (`apps/backend/src/lib/socket-auth.ts:14-32`). Rooms keyed by workspace / stream / user / agent_session. Postgres adapter (`server.ts:514`) means any backend instance can fan out to all connected sockets — no sticky routing needed.
- **Outbox → socket fanout**: `apps/backend/src/lib/outbox/broadcast-handler.ts:59-244`. Maps outbox event types to rooms via `STREAM_SCOPED_EVENTS` / `WORKSPACE_SCOPED_EVENTS` / `USER_SCOPED_EVENTS` tables in `apps/backend/src/lib/outbox/repository.ts:79-120`. **Bot-invocation events do not flow through it today.**
- **Bot auth**: `apps/backend/src/middleware/public-api-auth.ts:100-117` validates `threa_bk_*` keys via `BotApiKeyService.validateKey()`. Sets `req.botApiKey = { id, workspaceId, botId, name, scopes }`. Sockets do not accept bot keys today.

## 4. Proposed Architecture

### 4.1 Hybrid HTTP + WebSocket

```
                     ┌──────────────────────────────────────┐
   Pi / bot runtime  │                                      │
                     │  1. POST /bot-runtime/presence       │  ← HTTP (writes that persist)
                     │     (initial registration, key rot.) │
                     │                                      │
                     │  2. Open WS /bot, send `bot:hello`   │  ← WS (long-lived hint channel)
                     │     ───────────────────────────────► │
                     │     ◄ ─── `bot:bootstrap`            │
                     │           (pending invocations,      │
                     │            active actor map)         │
                     │                                      │
                     │  3. Idle. Server pushes              │
                     │     ◄ ─── `bot_invocation:available` │
                     │                                      │
                     │  4. POST /bot-invocations/claim ───► │  ← HTTP (atomic claim)
                     │     ◄ ─── invocation row             │
                     │                                      │
                     │  5. POST /steps, /complete, etc.───► │  ← HTTP (persist)
                     │                                      │
                     └──────────────────────────────────────┘
```

**HTTP stays canonical for everything that persists.** WS is purely a delivery channel for hints: "go check for work", "your session link was torn down", "active actor changed." Losing every socket must never lose state — the next `POST /claim` (whether triggered by a push or a backstop poll) still does the right thing.

### 4.2 New `/bot` Socket.IO Namespace

A dedicated namespace, not a multiplexed default namespace, because:

- **Different auth model.** Cookie vs API key. Mixing them in one middleware is a security smell.
- **Different room hierarchy.** User rooms (`ws:{ws}:user:{userId}`) are orthogonal to bot rooms (`bot:{ws}:{botId}`).
- **Different lifecycle.** A user's socket lives minutes; a bot's socket lives days. Different ping/timeout tuning, different reconnect strategy.
- **Explicit security boundary.** The user-facing socket cannot accidentally serve bot-key-auth code paths and vice versa.

Mirrors the existing pattern set by `/voice` (`apps/backend/src/features/voice-transcription/realtime-gateway.ts`).

### 4.3 Auth: Bot API Key in the WS Handshake

Bot connects with `auth: { token: "threa_bk_..." }` (Socket.IO handshake auth payload, transported in the upgrade request). New `createBotSocketAuthMiddleware(botApiKeyService)`:

1. Read `socket.handshake.auth.token`.
2. Reject if missing or doesn't start with `BOT_KEY_PREFIX`.
3. Call `botApiKeyService.validateKey(token)` (same code path as HTTP middleware).
4. Reject if scope set lacks `BOT_RUNTIME_WRITE` (the WS connection is functionally equivalent to a long-running presence heartbeat — same scope).
5. Stamp `socket.data.bot = { id, workspaceId, botId, scopes }`.

Fail closed on any thrown error (matches the precedent in `socket-auth.ts:21-30`).

### 4.4 Room Model

Four room patterns, picked narrowest-wins by `BroadcastHandler.dispatchBotEvent`:

- `bot:{workspaceId}` — auto-joined on socket connect (before `bot:hello`). Receives workspace-wide events: `bot:resync` with no `botId`.
- `bot:{workspaceId}:bot:{botId}` — auto-joined on `bot:hello`. Receives untargeted events for this bot: `bot_invocation:available` for invocations with `target_instance_id = NULL`, `bot:active_actor_changed`, `bot:archived`.
- `bot:{workspaceId}:bot:{botId}:instance:{instanceId}` — auto-joined on `bot:hello`. Receives instance-targeted events: `bot_invocation:available` for invocations with `target_instance_id = instanceId`, `bot_session_link:invalidated`.
- `bot:{workspaceId}:bot:{botId}:session:{runtimeSessionId}` — auto-joined on `bot:hello` when the runtime provides a `runtimeSessionId` (Pi-local). Receives session-pinned events: `bot_invocation:available` for invocations with `target_runtime_session_id = runtimeSessionId`.

A bot **cannot** subscribe to another bot's rooms. Both auto-joins are server-enforced from `socket.data.bot`; there is no client-driven `join` event in v1. (Symmetric to the existing default-namespace `join` validation but with no surface for the client to expand its access.)

### 4.5 New Outbox Events

All flow through the existing `BroadcastHandler`. Schema-only changes (new entries in `OutboxEventType` and a routing table for `bot:`-prefixed rooms).

| Event                          | Payload                                                                                                          | Target Room                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bot_invocation:available`     | `{ workspaceId, botId, invocationId, requiredCapability, targetInstanceId?, targetRuntimeSessionId? }`           | `bot:{ws}:{botId}:instance:{instanceId}` if `targetInstanceId` set, else `bot:{ws}:{botId}` |
| `bot_invocation:claimed`       | `{ workspaceId, botId, invocationId }` (no `claimedByInstanceId` — siblings don't need to know each other's IDs) | `bot:{ws}:{botId}` (siblings learn "stop racing this one" — best-effort nicety)             |
| `bot_invocation:cancelled`     | `{ workspaceId, botId, invocationId, reason }`                                                                   | `bot:{ws}:{botId}`                                                                          |
| `bot_session_link:invalidated` | `{ workspaceId, botId, instanceId, runtimeSessionId, rootStreamId }`                                             | `bot:{ws}:{botId}:instance:{instanceId}`                                                    |
| `bot:active_actor:changed`     | `{ workspaceId, rootStreamId, previousActorId?, newActorId? }`                                                   | `bot:{ws}:{botId}` for each affected bot                                                    |
| `bot:resync`                   | `{ workspaceId, botId?, instanceId?, reason }`                                                                   | most-specific of: `bot:{ws}:{botId}:instance:{instanceId}` → `bot:{ws}:{botId}` → workspace |

These are **purely informational pushes**. Persistence already happened. The bot reacts by issuing the appropriate HTTP call (claim, fetch, etc.), or — for `bot:resync` — by re-running the `bot:hello` handshake.

### 4.6 Outbox-First (INV-4, INV-7)

`BotRuntimeService.createInvocation()` and friends are updated so the outbox event is written **in the same transaction** as the domain row. That gives us:

- Crash-safe fanout. If the backend dies between insert and broadcast, the next dispatcher tick replays.
- Multi-instance correctness. `BroadcastHandler` already handles the "any backend can fan out" case via the postgres adapter.
- Zero new infrastructure. We are not introducing a parallel pubsub.

Concretely:

- `BotInvocationRepository.insertIdempotent` runs inside `withTransaction`, alongside `OutboxRepository.insert(db, "bot_invocation:available", payload)`. Outbox event fires **only on first insert** (not on `ON CONFLICT` reuse) — detected via `RETURNING xmax = 0`. Test must assert no double-fire on second call with the same idempotency key.
- The outbox handler at `invocation-outbox-handler.ts:113-189` invokes `createInvocation` once per mentioned bot in a loop. **Wrap the whole loop in one transaction** (`createInvocationsInTransaction(streamMessage, bots[])` taking the per-message context once) so we open one connection per inbound message instead of N. The current loop is N round-trips to a per-call `withTransaction`; the new pattern is one.
- `StreamActiveActorRepository.upsert` (any code path that mutates `stream_active_actors`, including `BotRuntimeService.setActiveActor` and `createOrLinkPiRemoteSessionInTransaction`) must write a `bot:active_actor:changed` outbox event in the same transaction, with `affectedBotIds = [previousActorId, newActorId].filter(isBot)`. If a future caller mutates this table without going through the service method, the push is silently absent and bots miss "you are no longer the active actor" hints. **Discipline: there must be exactly one mutation path, and it must always emit.** Add a comment on the repository method pointing at the service wrapper.

### 4.7 Bootstrap on Connect / Reconnect (INV-53)

**Order matters.** The server-side `bot:hello` handler runs `socket.join(...)` **before** issuing the bootstrap SELECT. If we read first and join second, a row inserted between the two would emit a push to an empty room and the bot would not see the invocation until the safety-backstop poll fires. Joining first means the bot may see the same invocation in both the live push and the bootstrap snapshot — dedupe by `invocationId` is the bot's responsibility, exactly mirroring how the user-facing socket reconciles `bootstrap → message:created` (INV-53).

Bootstrap payload:

```ts
{
  serverGeneratedAt: string,     // ISO; cursor the bot persists for the next reconnect (Q1)
  pendingInvocations: Array<{    // capability-filtered, instance-targeted-or-untargeted
    invocationId, requiredCapability, createdAt,
    targetInstanceId, targetRuntimeSessionId,
  }>,
  activeActorByStream: Array<{   // for streams this bot is the active actor of
    rootStreamId, activeActorId,
  }>,
  activeSessionLinks: Array<{    // for this instanceId
    runtimeSessionId, rootStreamId, activeStreamId,
  }>,
}
```

**Cursor (`serverGeneratedAt`).** The bot persists this across restarts (local sqlite / file / whatever — bot SDK's choice) and includes it on the next `bot:hello` as `sinceCursor?: string`. Server semantics:

- If `sinceCursor` is provided **and not older than `maxLookback` (e.g. 24 h)**, filter pending-invocations to `created_at > sinceCursor`.
- Otherwise (no cursor, or stale cursor), return the full pending set (still capped at 100). Stale cursor → log + treat as cold start; the bot's local state was already gone or out of date.
- Invocations claimed by **this** instance are always returned regardless of cursor — they are in-progress work the bot must still drive to completion.

The cursor is advisory. A bot that loses its local state simply omits `sinceCursor` and gets a full snapshot. Server always echoes back the new `serverGeneratedAt` so the bot can advance the cursor without coordinating client clock.

**Server-initiated re-sync (`bot:resync`).** A sixth outbox event type that asks a bot (or all bots, or one instance) to discard its in-memory state and run the `bot:hello` handshake again. Triggers:

- Admin operation flipping a workspace setting that affects bot behavior.
- Future schema migrations where the invocation shape changes.
- Operator-side "something looks off, please refresh" knob.

Payload: `{ workspaceId, botId?: string, instanceId?: string, reason: string }`. Routing is the most specific room available — instance room if `instanceId` set, bot room if only `botId`, workspace room (all bot connections in workspace) if neither. The bot SDK responds by emitting `bot:hello` again with its persisted cursor. Server returns a fresh bootstrap; bot reconciles by `invocationId` dedupe (INV-53 pattern).

The bot then issues `POST /claim` for each pending invocation it wants to take, exactly the same as if it had received a live `bot_invocation:available` push. Bootstrap closes the gap between "what I missed while disconnected" and "what's pending now," matching INV-53 (subscription pairs with bootstrap, bootstrap invalidated on resubscribe).

The bootstrap is computed from two parallel DB reads per scope (`available` + `ownedClaims`), each capped at 200 rows. It is **not** the place to put unbounded history — that's still `GET /streams/:id/messages`.

### 4.8 Presence on WS

The WS connection itself is the truth — there is **no periodic ticker** writing `last_seen_at` for connected sockets. Two competing truths would drift; we pick one.

- On `bot:hello` (after auth), upsert `bot_runtime_instances` with `status = 'available'`, `accepting_invocations = true`, `last_seen_at = NOW()`. Same code path as `POST /bot-runtime/presence`. **This is the only WS-driven write to `bot_runtime_instances` during a connection's lifetime.**
- A new in-memory `BotSocketRegistry` (mirror of the existing `UserSocketRegistry`) tracks `(workspaceId, botId, instanceId) → Set<Socket>`. This is the live-online signal.
- On `disconnect`, the socket is removed from the registry. **After a 30 s grace window** with no reconnect from any socket of the same `(workspaceId, botId, instanceId)`, the registry calls `BotRuntimeInstanceRepository.markOffline(...)` which sets `status='offline'`, `accepting_invocations=false`, and bumps `last_seen_at = NOW()`. The grace absorbs Wi-Fi blips and laptop-lid-close events without flapping the UI. **`markOffline` must NOT delete the row** — the row is the routing target for any `target_instance_id`-pinned invocations (`bot_invocations.target_instance_id`), and `BotInvocationRepository.claimOne` requires it to exist (`repository.ts:462-468`).
- For "is this bot online right now?" surfaces (e.g. bot picker in the UI), readers should prefer `BotSocketRegistry.isOnline(scope)` over `last_seen_at`. The DB row remains useful for cross-instance reads (the registry is in-memory per-backend) and for offline bots — once `markOffline` runs, `last_seen_at` is fresh and accurate.
- HTTP `POST /bot-runtime/presence` is still supported for: explicit status transitions (`'busy'`, `'paused'`), capability changes, **and public-key rotation under the E2E design**. Bots can call it any time, WS or no.

### 4.9 Backwards Compatibility and Discovery

- All HTTP endpoints unchanged. The HTTP-only bot polling at 2 s continues to work.
- The new `/bot` namespace is purely additive. A bot that does not connect to it sees no behavior change.
- The recommended fallback path for the new client: open WS; on connect failure (auth, network, region unreachable) or repeated disconnects, fall back to polling at the existing cadence. Backend has no special mode toggle — both transports just work.
- **Polling reduction is opt-in on the client.** Once a bot is on WS, it can drop its claim-poll cadence from 2 s to 30 s as a safety backstop. Backend doesn't enforce this; it's a client decision.

**`wsUrl` discovery.** WebSocket connections bypass the worker and go directly to the regional backend (`docs/system-overview.md:54-57`). Bots need to know the URL. Two paths, both shipped:

1. **`GET /api/workspaces/:id/config`** already returns `{ region, wsUrl }` unauthenticated (the worker resolves the region from KV; see `apps/workspace-router/src/index.ts:257-271`). The bot SDK calls this once at startup and caches the URL. No new endpoint, no auth change.
2. **Echo `wsUrl` in the `POST /bot-runtime/presence` response.** Saves the bot one HTTP round-trip on first connect, and keeps the field discoverable even if a future change moves it. Trivial backend change.

Older bots that don't know about WS keep ignoring these fields — both endpoints are already serving them or extending them in a forward-compatible way.

### 4.10 E2E Encryption Alignment (PR #621)

Per [PR #621](https://github.com/threahq/threa/pull/621), the wire shape for messages and invocation steps must be identical across HTTP and WS — a top-level `{kind: 'plaintext' | 'e2e', ...}` discriminator carrying an opaque envelope that the server never decrypts. Reading that PR for the exact invariants and field names is worthwhile before implementing; the references here are conceptual.

Concretely for this revamp:

- **`bot:hello` payload accepts the same `publicKey` field** PR #621 adds to the presence body, with the same shape. Persisted via the `bot_runtime_keys` table introduced by #621. **Per-session semantics:** the WS handler upserts the row keyed by `(workspaceId, botId, runtimeSessionId)` and writes the key once per session — on first `bot:hello` for that `runtimeSessionId`, the key is stored; subsequent reconnects with the same `runtimeSessionId` no-op the key write (still upsert the row's `last_seen_at` if applicable). Explicit key rotation continues via `POST /bot-runtime/presence`; the WS path is incidental registration. (Confirm against PR #621 before implementing — the runtimeSessionId-keyed table shape is sketched here but the canonical column names live in that PR.)
- **`bot_invocation:available` push is plaintext metadata only** — `invocationId`, `requiredCapability`, target hints. It carries **no message content**, no preview text, no envelope. The bot fetches the source message over HTTP and decrypts client-side, identical to the HTTP-poll path. This matches the PR's "preview surfaces carry no content for E2E streams" stance.
- **If we later push `message:created` envelopes to bots** (a v2 optimization, not in this scope), forwarding must be byte-verbatim — server never touches `ciphertext` or `envelope`. The PR explicitly requires this for socket fanout to match HTTP semantics.
- **`bot_session_link:invalidated` is purely a routing signal** — no content, no key material. Safe on E2E streams.

The transport revamp is intentionally orthogonal to the crypto revamp. If PR #621 lands first, this PR preserves its field shapes. If this PR lands first, PR #621 plugs into the same hello-handshake (adding `publicKey` to its Zod schema) and the same outbox events (no content fields to encrypt). Either ordering works.

## 5. Failure Modes & Disconnect Handling

| Failure                                                               | Today                                | New                                                                                                                                                                             | Mitigation                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Bot WS drops mid-invocation                                           | n/a (no WS)                          | Pending claim continues; bot reconnects, calls `/renew` from memory; if claim expired, server reissues `bot_invocation:available` to the bot's room and any sibling can pick up | `claim_expires_at` + `FOR UPDATE SKIP LOCKED` already handle this. WS dropping doesn't release the claim — only TTL does. |
| Backend dies between invocation insert and broadcast                  | n/a                                  | Outbox replays on next dispatcher cycle; bot gets the push within seconds                                                                                                       | Outbox pattern, INV-4                                                                                                     |
| Bot connected to backend instance A; invocation created on instance B | n/a                                  | Postgres adapter fans out; bot on A sees the push                                                                                                                               | Already in place                                                                                                          |
| Bot misses a push (rare; e.g. socket closed during emit)              | n/a                                  | Safety-backstop `POST /claim` at 30 s catches it                                                                                                                                | Bootstrap on reconnect handles the planned-disconnect case; backstop catches the unplanned-edge case                      |
| Bot key revoked                                                       | Subsequent HTTP calls 401            | Existing WS continues to receive pushes until a periodic re-validate fires (see §6 — included in v1)                                                                            | Re-validate the key on a 60 s ticker per socket; force-disconnect on revocation. Closes the data-exfil window cheaply.    |
| Bot opens many WS connections                                         | Possible today via many keys         | Same                                                                                                                                                                            | Add a per-key connection cap in v2 (e.g. 10 concurrent). Out of scope for v1 — friends-and-family scale.                  |
| Bot fails to call `/renew` in time                                    | Claim auto-expires, sibling picks up | Same                                                                                                                                                                            | Unchanged. WS does not change claim semantics.                                                                            |

The defining property: **HTTP is the truth, WS is the latency optimization.** Every failure mode degrades to "fall back to the HTTP path you already have."

## 6. Security Model

- **WS handshake auth is mandatory.** No anonymous `/bot` connections. Reject with `Error: "Authentication failed"` matching the existing socket-auth precedent.
- **Bot can only join its own rooms.** Server auto-joins from `socket.data.bot`. No client-emitted `join` event in v1.
- **Scope check on connect.** `BOT_RUNTIME_WRITE` required. Same scope as HTTP presence/sessions endpoints, so a key that can write presence over HTTP can connect over WS — no privilege escalation.
- **`instanceId` and `runtimeSessionId` are room-name fragments.** Both must be pattern-constrained in the `bot:hello` Zod schema (e.g. `^[A-Za-z0-9_-]{1,64}$`) to prevent cross-namespace room collisions (`bot:{ws}:{botId}:instance:../user:hacker`). Plain Zod string validation is not enough — must be a regex (INV-55, INV-11).
- **Revocation closure (60 s ticker per socket).** `BotApiKeyService.validateKey` has no cache today (`bot-api-key-service.ts:146-171` always hits the DB), so HTTP revocation is immediate. The WS keeps a stale-auth window unless we close it. v1 includes a per-socket 60 s re-validate ticker (~3 lines): on failure, force-disconnect the socket. Worst-case data-exfil window: ≤60 s of `bot_invocation:available` payloads (metadata only — invocation IDs and capability hints; no message content).
- **Bot bootstrap is instance-scoped.** Pending-invocation reads filter `(status = 'pending' OR (status = 'claimed' AND claimed_by_instance_id = $instanceId))` so a reconnecting instance does not learn the existence of claims held by siblings.
- **CF Worker pass-through.** WebSocket connections bypass the worker entirely (`docs/system-overview.md:54-57`); the upgrade itself is one worker request, then frames flow direct to the regional backend. No worker change needed.
- **TLS termination is unchanged.** Same ALB / Express server.
- **No new secrets.** The bot key already authorizes everything the WS connection lets it do.
- **Every backend instance must register the `/bot` namespace at boot.** `@socket.io/postgres-adapter` fans out per namespace; if instance A never called `io.of("/bot")`, broadcasts from B silently no-op on A's sockets. Document the invariant; no per-instance feature flag for the `/bot` namespace until we have a story for adapter-aware gating.
- **Observability for abuse.** Add Prometheus metrics: `bot_ws_connections_active{workspace_id, bot_id}`, `bot_ws_events_total{event_type, direction}`, `bot_ws_connection_duration_seconds`. Mirror of the existing `wsConnectionsActive`.

## 7. Rollout Phases

**Phase 1 — Backend additive (this PR).** Everything above. No client changes. Behind no feature flag, but unused until a client opts in. Verified by:

- New unit/integration tests for `/bot` namespace handshake, auto-join, bootstrap, push routing.
- Existing HTTP claim tests continue to pass.
- Manual smoke: connect with `wscat` + bot key, observe `bot:bootstrap`, trigger an invocation via the existing HTTP path, observe `bot_invocation:available`.

**Phase 2 — Client adoption.** Pi runtime / bot SDK opens WS by default with HTTP-poll fallback. Polling cadence drops to 30 s. Done in a separate PR once Phase 1 is in.

**Phase 3 — Per-key connection caps + revocation broadcast.** Once we have more than ~5 bot keys live, add `bot_ws_connections_per_key` cap and a `bot:key:revoked` push that forces all sockets for that key to disconnect.

**Phase 4 — Push `message:created` envelope into bot stream rooms.** Eliminates the per-invocation `GET /messages/:id` round-trip. Requires E2E envelope forwarding to be settled (likely after PR #621 lands).

## 8. Open Questions

Resolved:

1. **Bootstrap cursor.** Yes — bootstrap returns `serverGeneratedAt` and the bot persists it across restarts. On next `bot:hello` the bot sends it back as `sinceCursor`, and the server filters pending-invocations to `created_at > sinceCursor` when present and recent enough. Always echo a fresh `serverGeneratedAt` so the bot can advance the cursor without depending on its own clock. See §4.7 for the full semantics.
2. **`bot:resync` event.** Yes — added as a sixth outbox event type. Server-initiated, routes to the most specific room (instance → bot → workspace). Bot reacts by re-running `bot:hello` with its persisted cursor.
3. **Public-key registration on `bot:hello`.** Per session — keyed by `(workspaceId, botId, runtimeSessionId)`. Write once per session on first hello, no-op on reconnects with the same `runtimeSessionId`. Matches PR #621's per-session model. See §4.10.
4. **`BroadcastHandler` throughput (deferred).** Single listener stays for v1. If bot events ever spike, split into a separate `BotBroadcastHandler` with its own `listenerId` consuming the same outbox in parallel — same pattern as `BotInvocationOutboxHandler` already living alongside `BroadcastHandler`. Note for v2.

Still open:

5. **Per-IP connection limits at the load balancer?** Out of scope for v1 (friends-and-family scale). Revisit when more than a handful of bot keys are live.

## 9. Success Criteria

- Backend tests for new WS handshake, auto-join, bootstrap, push routing — all passing.
- A single connected bot that previously made ~30 worker invocations per minute (claim every 2 s) makes ≤ 2 per minute at idle (one for the safety-backstop `/claim`, one for occasional presence rotation), after the client follow-up ships.
- No regression in existing HTTP claim/complete/fail latency or correctness.
- E2E PR #621 lands on top of this without renegotiating the wire shape.
