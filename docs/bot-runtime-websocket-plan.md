# Bot Runtime WebSocket Revamp — Plan

> **Scope:** Backend-only. Client-side adoption (bot SDK / Pi runtime) is a follow-up. Backwards-compatible: every existing polling bot keeps working unchanged.

## 1. Problem

The current bot scratchpad invocation framework is **pull-based**. A bot instance discovers work by repeatedly issuing `POST /api/v1/workspaces/:id/bot-invocations/claim`. Each call is a Cloudflare Worker invocation (via `apps/workspace-router`) + a KV lookup + a backend hit, even when the answer is "nothing to do." With one bot per workspace polling every 2–3 seconds at idle, the worker quota is the binding constraint — we've already burnt 50 % of the daily free tier with one user.

Bots also poll `GET /streams/:id/messages` to discover follow-up turns mid-session, and POST `/bot-runtime/presence` on a heartbeat cadence. Each of those is another worker invocation per cycle.

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

Two room patterns, both keyed by bot identity:

- `bot:{workspaceId}:{botId}` — auto-joined on connect. Receives untargeted events for this bot: `bot_invocation:available` for invocations with `target_instance_id = NULL`, `bot:active_actor:changed`, `bot:archived`.
- `bot:{workspaceId}:{botId}:instance:{instanceId}` — auto-joined when the bot identifies its instance in `bot:hello`. Receives instance-targeted events: `bot_invocation:available` for invocations with `target_instance_id = instanceId`, `bot_session_link:invalidated`.

A bot **cannot** subscribe to another bot's rooms. Both auto-joins are server-enforced from `socket.data.bot`; there is no client-driven `join` event in v1. (Symmetric to the existing default-namespace `join` validation but with no surface for the client to expand its access.)

### 4.5 New Outbox Events

All flow through the existing `BroadcastHandler`. Schema-only changes (new entries in `OutboxEventType` and a routing table for `bot:`-prefixed rooms).

| Event                          | Payload                                                                                                | Target Room                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `bot_invocation:available`     | `{ workspaceId, botId, invocationId, requiredCapability, targetInstanceId?, targetRuntimeSessionId? }` | `bot:{ws}:{botId}:instance:{instanceId}` if `targetInstanceId` set, else `bot:{ws}:{botId}` |
| `bot_invocation:claimed`       | `{ workspaceId, botId, invocationId, claimedByInstanceId }`                                            | `bot:{ws}:{botId}` (so siblings stop racing — best-effort nicety)                           |
| `bot_invocation:cancelled`     | `{ workspaceId, botId, invocationId, reason }`                                                         | `bot:{ws}:{botId}`                                                                          |
| `bot_session_link:invalidated` | `{ workspaceId, botId, instanceId, runtimeSessionId, rootStreamId }`                                   | `bot:{ws}:{botId}:instance:{instanceId}`                                                    |
| `bot:active_actor:changed`     | `{ workspaceId, rootStreamId, previousActorId?, newActorId? }`                                         | `bot:{ws}:{botId}` for each affected bot                                                    |

These are **purely informational pushes**. Persistence already happened. The bot reacts by issuing the appropriate HTTP call (claim, fetch, etc.).

### 4.6 Outbox-First (INV-4, INV-7)

`BotRuntimeService.createInvocation()` and friends are updated so the outbox event is written **in the same transaction** as the domain row. That gives us:

- Crash-safe fanout. If the backend dies between insert and broadcast, the next dispatcher tick replays.
- Multi-instance correctness. `BroadcastHandler` already handles the "any backend can fan out" case via the postgres adapter.
- Zero new infrastructure. We are not introducing a parallel pubsub.

Concretely, `BotInvocationRepository.insertIdempotent` gets called inside `withTransaction`, alongside `OutboxRepository.insert(db, "bot_invocation:available", payload)`. The two existing call sites in `invocation-outbox-handler.ts:113-189` switch to a `*InTransaction` service variant.

### 4.7 Bootstrap on Connect / Reconnect (INV-53)

On every `connection` event, the server emits `bot:bootstrap` directly to the joining socket with:

```ts
{
  serverTime: string,            // ISO; lets the bot reason about clock skew
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

The bot then issues `POST /claim` for each pending invocation it wants to take, exactly the same as if it had received a live `bot_invocation:available` push. Bootstrap closes the gap between "what I missed while disconnected" and "what's pending now," matching INV-53 (subscription pairs with bootstrap, bootstrap invalidated on resubscribe).

The bootstrap is computed from a single DB read per scope (cap row count, e.g. limit 100 pending). It is **not** the place to put unbounded history — that's still `GET /streams/:id/messages`.

### 4.8 Presence on WS

- On `connection` (after auth + `bot:hello`), upsert `bot_runtime_instances` with `status = 'available'`, `accepting_invocations = true`. Same code path as `POST /bot-runtime/presence`.
- A new in-memory `BotSocketRegistry` (mirror of the existing `UserSocketRegistry`) tracks `(workspaceId, botId, instanceId) → Set<Socket>`.
- A backend-side ticker (e.g. every 25 s) batches `UPDATE bot_runtime_instances SET last_seen_at = NOW() WHERE (workspaceId, botId, instanceId) IN (...)` for all connected instances. One query per tick across all bots on the box, not one per bot — this is why we don't write per-frame.
- On `disconnect`, the socket is removed from the registry. **After a 30 s grace window** with no reconnect from any socket of the same `(workspaceId, botId, instanceId)`, the registry calls `BotRuntimeInstanceRepository.markOffline(...)`. The grace absorbs Wi-Fi blips and laptop-lid-close events without flapping the UI.
- HTTP `POST /bot-runtime/presence` is still supported for: explicit status changes (`'busy'`, `'paused'`), capability changes, **and public-key rotation under the E2E design**. WS connection just keeps `last_seen_at` fresh.

### 4.9 Backwards Compatibility

- All HTTP endpoints unchanged. The HTTP-only bot polling at 2 s continues to work.
- The new `/bot` namespace is purely additive. A bot that does not connect to it sees no behavior change.
- The recommended fallback path for the new client: open WS; on connect failure (auth, network, region unreachable) or repeated disconnects, fall back to polling at the existing cadence. Backend has no special mode toggle — both transports just work.
- **Polling reduction is opt-in on the client.** Once a bot is on WS, it can drop its claim-poll cadence from 2 s to 30 s as a safety backstop. Backend doesn't enforce this; it's a client decision.
- Optional response header `X-Threa-WS-Available: 1` on `/bot-invocations/claim` so older clients can discover the new transport without us shipping a config endpoint. Newer clients ignore (they know).

### 4.10 E2E Encryption Alignment (PR #621)

The wire shape across HTTP and WS must be identical (INV-E3 from #621). Concretely:

- **`bot:hello` payload accepts the same `publicKey: string` field** that PR #621 adds to the presence body. Persisted via the existing `bot_runtime_keys` table (introduced by #621). Key rotation continues via explicit `POST /bot-runtime/presence` — the WS path simply registers the current key.
- **`bot_invocation:available` push is plaintext metadata only** — `invocationId`, `requiredCapability`, target hints. It carries **no message content**. The bot then `GET`s the source message over HTTP and decrypts client-side, identical to the HTTP-poll path. There is no E2E content in the push.
- **If we later push `message:created` events to bots** (a v2 optimization, not in this scope), the envelope is forwarded **verbatim** — server never sees plaintext. That mirrors INV-E3.
- **No preview content in pushes** (INV-E4). Pushes carry IDs and capability hints; the bot fetches what it needs.
- **`bot_session_link:invalidated` is purely a routing signal** — no content, no key material. Safe on E2E streams.

The transport revamp is intentionally orthogonal to the crypto revamp. If PR #621 lands first, this PR just preserves the existing field shape. If this PR lands first, PR #621 plugs into the same hello-handshake (adding `publicKey` to its schema) and the same outbox events (no content fields to encrypt).

## 5. Failure Modes & Disconnect Handling

| Failure                                                               | Today                                | New                                                                                                                                                                             | Mitigation                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Bot WS drops mid-invocation                                           | n/a (no WS)                          | Pending claim continues; bot reconnects, calls `/renew` from memory; if claim expired, server reissues `bot_invocation:available` to the bot's room and any sibling can pick up | `claim_expires_at` + `FOR UPDATE SKIP LOCKED` already handle this. WS dropping doesn't release the claim — only TTL does. |
| Backend dies between invocation insert and broadcast                  | n/a                                  | Outbox replays on next dispatcher cycle; bot gets the push within seconds                                                                                                       | Outbox pattern, INV-4                                                                                                     |
| Bot connected to backend instance A; invocation created on instance B | n/a                                  | Postgres adapter fans out; bot on A sees the push                                                                                                                               | Already in place                                                                                                          |
| Bot misses a push (rare; e.g. socket closed during emit)              | n/a                                  | Safety-backstop `POST /claim` at 30 s catches it                                                                                                                                | Bootstrap on reconnect handles the planned-disconnect case; backstop catches the unplanned-edge case                      |
| Bot key revoked                                                       | Subsequent HTTP calls 401            | Next `validateKey` cache miss invalidates; existing WS continues until ping-timeout (≤60 s)                                                                                     | Add an explicit `bot:disconnect_all_for_key` event in v2; v1 accepts up to one ping cycle of leakage                      |
| Bot opens many WS connections                                         | Possible today via many keys         | Same                                                                                                                                                                            | Add a per-key connection cap in v2 (e.g. 10 concurrent). Out of scope for v1 — friends-and-family scale.                  |
| Bot fails to call `/renew` in time                                    | Claim auto-expires, sibling picks up | Same                                                                                                                                                                            | Unchanged. WS does not change claim semantics.                                                                            |

The defining property: **HTTP is the truth, WS is the latency optimization.** Every failure mode degrades to "fall back to the HTTP path you already have."

## 6. Security Model

- **WS handshake auth is mandatory.** No anonymous `/bot` connections. Reject with `Error: "Authentication failed"` matching the existing socket-auth precedent.
- **Bot can only join its own rooms.** Server auto-joins from `socket.data.bot`. No client-emitted `join` event in v1.
- **Scope check on connect.** `BOT_RUNTIME_WRITE` required. Same scope as HTTP presence/sessions endpoints, so a key that can write presence over HTTP can connect over WS — no privilege escalation.
- **CF Worker pass-through.** The `apps/workspace-router` worker already routes `/api/*` per-region. WS upgrade requests on the same path inherit the same routing — no worker change needed, and the worker counts the upgrade as one request, then stops counting frames (frames don't traverse the worker once upgraded). **This is the core cost saving.**
- **TLS termination is unchanged.** Same ALB / Express server.
- **No new secrets.** The bot key already authorizes everything the WS connection lets it do.
- **Observability for abuse.** Add Prometheus metrics: `bot_ws_connections_active{workspace_id, bot_id}`, `bot_ws_events_total{event_type, direction}`, `bot_ws_connection_duration_seconds`. Mirror of the existing `wsConnectionsActive` etc.

## 7. Rollout Phases

**Phase 1 — Backend additive (this PR).** Everything above. No client changes. Behind no feature flag, but unused until a client opts in. Verified by:

- New unit/integration tests for `/bot` namespace handshake, auto-join, bootstrap, push routing.
- Existing HTTP claim tests continue to pass.
- Manual smoke: connect with `wscat` + bot key, observe `bot:bootstrap`, trigger an invocation via the existing HTTP path, observe `bot_invocation:available`.

**Phase 2 — Client adoption.** Pi runtime / bot SDK opens WS by default with HTTP-poll fallback. Polling cadence drops to 30 s. Done in a separate PR once Phase 1 is in.

**Phase 3 — Per-key connection caps + revocation broadcast.** Once we have more than ~5 bot keys live, add `bot_ws_connections_per_key` cap and a `bot:key:revoked` push that forces all sockets for that key to disconnect.

**Phase 4 — Push `message:created` envelope into bot stream rooms.** Eliminates the per-invocation `GET /messages/:id` round-trip. Requires E2E envelope forwarding to be settled (likely after PR #621 lands).

## 8. Open Questions

1. **Should bootstrap include an explicit `serverGeneratedAt` cursor that the bot persists across restarts?** Useful for "give me everything since X" semantics on long bot reboots. v1 just gives all pending; revisit if pending-list cap (100) becomes a problem.
2. **Do we want a `bot:resync` server-initiated event to force a bot to re-bootstrap?** Useful if backend invariants change (e.g. major schema migration). v1: no, just disconnect; client reconnects → bootstrap is implicit.
3. **Should `bot_invocation:claimed` go to the **whole** bot room or only the instance that lost?** Whole room is simpler; cost is one extra event per claim. Going with whole room.
4. **Public-key registration on `bot:hello` — write on every connect, or only when changed?** PR #621 implies per-session, so per-connect is fine. Confirm with the e2e PR author.
5. **Per-IP connection limits at the load balancer?** Out of scope for v1 (single-user scale).

## 9. Success Criteria

- Backend tests for new WS handshake, auto-join, bootstrap, push routing — all passing.
- A single connected bot that previously made ~30 worker invocations per minute (claim every 2 s) makes ≤ 2 per minute at idle (one for the safety-backstop `/claim`, one for occasional presence rotation), after the client follow-up ships.
- No regression in existing HTTP claim/complete/fail latency or correctness.
- E2E PR #621 lands on top of this without renegotiating the wire shape.
