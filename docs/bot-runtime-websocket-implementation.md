# Bot Runtime WebSocket Revamp — Implementation Guide

> Companion to `docs/bot-runtime-websocket-plan.md`. This file is the step-by-step build order. Each step is independently testable. Stop and verify between steps.

## 0. Pre-flight

- Branch: `claude/vibrant-ptolemy-JgLoF` (already cut).
- No DB migration in Phase 1. All changes are application code + new outbox event types.
- Tests run via `bun run test`. Touch a single feature folder at a time so the affected suite is small and fast.

## 1. New Outbox Event Types

**File:** `apps/backend/src/lib/outbox/repository.ts`

Add to `OutboxEventType` union (after `link_preview:dismissed`):

```ts
  | "bot_invocation:available"
  | "bot_invocation:claimed"
  | "bot_invocation:cancelled"
  | "bot_session_link:invalidated"
  | "bot:active_actor_changed"
```

Add a new exported tag for bot-scoped events so `BroadcastHandler` can route them with a dedicated branch (parallel to `STREAM_SCOPED_EVENTS` / `USER_SCOPED_EVENTS`):

```ts
export const BOT_SCOPED_EVENTS = [
  "bot_invocation:available",
  "bot_invocation:claimed",
  "bot_invocation:cancelled",
  "bot_session_link:invalidated",
  "bot:active_actor_changed",
] as const satisfies readonly OutboxEventType[]

export type BotScopedEventType = (typeof BOT_SCOPED_EVENTS)[number]

export function isBotScopedEvent(event: { eventType: string }): event is OutboxEventWithType<BotScopedEventType> {
  return BOT_SCOPED_EVENTS.includes(event.eventType as BotScopedEventType)
}
```

Extend `OutboxEventPayloadMap` with the five payloads. Keep them flat (no nested envelopes) so the dispatcher can read `workspaceId` and `botId` directly for routing without parsing nested objects.

```ts
"bot_invocation:available": {
  workspaceId: string
  botId: string
  invocationId: string
  requiredCapability: BotInvocationCapability
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  createdAt: string  // ISO; consumers don't have access to the row's createdAt
}
"bot_invocation:claimed": {
  workspaceId: string
  botId: string
  invocationId: string
  claimedByInstanceId: string
}
"bot_invocation:cancelled": {
  workspaceId: string
  botId: string
  invocationId: string
  reason: "source_message_deleted" | "bot_archived" | "manual"
}
"bot_session_link:invalidated": {
  workspaceId: string
  botId: string
  instanceId: string
  runtimeSessionId: string
  rootStreamId: string
  reason: "user_unlinked" | "instance_offline" | "manual"
}
"bot:active_actor_changed": {
  workspaceId: string
  rootStreamId: string
  previousActorType: "bot" | "persona" | null
  previousActorId: string | null
  newActorType: "bot" | "persona" | null
  newActorId: string | null
  // For routing: the set of bots that need to know. Computed at insert time
  // from the previous + new actor IDs. Keeps the dispatcher routing-pure.
  affectedBotIds: string[]
}
```

**Test (existing suite, regression):** `bun test apps/backend/src/lib/outbox/` — no new tests yet; just confirm type-only changes compile.

## 2. Wire Outbox Events into `BotRuntimeService`

**File:** `apps/backend/src/features/bot-runtimes/service.ts`

Today `createInvocation` calls `BotInvocationRepository.insertIdempotent(this.pool, …)` directly. Move it into a `withTransaction` and write the outbox event alongside the insert.

```ts
async createInvocation(params: { … }): Promise<BotInvocation> {
  return withTransaction(this.pool, (db) =>
    this.createInvocationInTransaction(db, params)
  )
}

async createInvocationInTransaction(
  db: Querier,
  params: { … }
): Promise<BotInvocation> {
  const row = await BotInvocationRepository.insertIdempotent(db, { … })

  // Idempotent insert returns the existing row on conflict — only broadcast
  // for first-time inserts. `insertIdempotent` should return a marker we can
  // distinguish (e.g. a second return value, or check createdAt vs updatedAt).
  // Easiest: have the repo return `{ row, inserted: boolean }` from
  // `RETURNING xmax = 0 AS inserted`.
  if (!row.wasNewlyInserted) return row.invocation

  await OutboxRepository.insert(db, "bot_invocation:available", {
    workspaceId: row.invocation.workspaceId,
    botId: row.invocation.actorId,
    invocationId: row.invocation.id,
    requiredCapability: row.invocation.requiredCapability,
    targetInstanceId: row.invocation.targetInstanceId,
    targetRuntimeSessionId: row.invocation.targetRuntimeSessionId,
    createdAt: row.invocation.createdAt.toISOString(),
  })

  return row.invocation
}
```

The "newly inserted vs reused" signal — update `BotInvocationRepository.insertIdempotent` to detect it with `xmax = 0` (Postgres idiom that's true for fresh inserts, false for ON CONFLICT DO UPDATE):

```sql
RETURNING *, (xmax = 0) AS was_newly_inserted
```

Map the column in `mapInvocation` (or return a wrapper `{ invocation, wasNewlyInserted }`). Tests in `repository.test.ts` should assert: inserting twice with same idempotency key returns `wasNewlyInserted: true` then `false`.

**Also update `completeClaim` to emit `bot_invocation:claimed`:**

`completeClaim` already runs as a single UPDATE that returns the row on success. Wrap the public-API handler path (or move the emit into a service method) so that on successful completion we also write `bot_invocation:claimed`. Same `withTransaction` pattern.

Actually — for `claimed`, **emit it from `claimOne` not `completeClaim`**. The "stop racing" signal is most useful at claim time, not completion time. Update `BotInvocationRepository.claimOne` to be called from a `createInvocationClaim*InTransaction` service method that emits the outbox event in the same tx as the claim UPDATE.

**Callers to update** (`apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts:113, 167`): no change needed — they call `BotRuntimeService.createInvocation`, which now handles the outbox emit internally.

**Test:** `apps/backend/src/features/bot-runtimes/service.test.ts` (new or extend) — `createInvocation` writes both rows in one tx; second call with same idempotency key writes only the row (no second outbox event).

## 3. Routing in `BroadcastHandler`

**File:** `apps/backend/src/lib/outbox/broadcast-handler.ts`

Add a branch alongside the existing stream/user/workspace routing. The dispatcher already has a per-event `switch`-equivalent; extend with `isBotScopedEvent(event)`.

```ts
if (isBotScopedEvent(event)) {
  await this.dispatchBotEvent(event)
  continue
}
```

`dispatchBotEvent` resolves the target room(s) per event type. Reference table (keep this in the source as a comment):

| `event.eventType`                                    | Room(s)                                            |
| ---------------------------------------------------- | -------------------------------------------------- |
| `bot_invocation:available` (with `targetInstanceId`) | `bot:{ws}:{botId}:instance:{targetInstanceId}`     |
| `bot_invocation:available` (no `targetInstanceId`)   | `bot:{ws}:{botId}`                                 |
| `bot_invocation:claimed`                             | `bot:{ws}:{botId}`                                 |
| `bot_invocation:cancelled`                           | `bot:{ws}:{botId}`                                 |
| `bot_session_link:invalidated`                       | `bot:{ws}:{botId}:instance:{instanceId}`           |
| `bot:active_actor_changed`                           | `bot:{ws}:{botId}` for each id in `affectedBotIds` |

Crucially: emit on `io.of("/bot")`, not the default namespace. Inject the bot namespace as a dependency on `BroadcastHandler` so we don't reach for a global. Current constructor takes `io: Server`; add `botIo: Namespace` (or pass both as `{ defaultNs, botNs }`).

Reuse `wsMessagesTotal` for metrics with a new `namespace` label (`"/" | "/bot"`).

**Test:** `apps/backend/src/lib/outbox/broadcast-handler.test.ts` — extend with: insert a `bot_invocation:available` outbox event, assert it's emitted on `bot:{ws}:{botId}` and not on the default namespace. Use the existing in-memory Socket.IO test fixture.

## 4. Bot Socket Auth Middleware

**File (new):** `apps/backend/src/features/bot-runtimes/socket-auth.ts`

```ts
import type { Socket } from "socket.io"
import type { ExtendedError } from "socket.io"
import { BOT_KEY_PREFIX, WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import type { BotApiKeyService } from "../public-api"

export function createBotSocketAuthMiddleware(deps: { botApiKeyService: BotApiKeyService }) {
  return async (socket: Socket, next: (err?: ExtendedError) => void): Promise<void> => {
    const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : null
    if (!token || !token.startsWith(BOT_KEY_PREFIX)) {
      return next(new Error("Missing bot API key"))
    }
    try {
      const key = await deps.botApiKeyService.validateKey(token)
      if (!key) return next(new Error("Invalid bot API key"))
      if (!key.scopes.has(WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE)) {
        return next(new Error("Insufficient scope"))
      }
      socket.data.bot = {
        id: key.id,
        workspaceId: key.workspaceId,
        botId: key.botId,
        scopes: key.scopes,
      }
      next()
    } catch {
      // Fail closed — mirror lib/socket-auth.ts:21-30 precedent.
      next(new Error("Authentication failed"))
    }
  }
}
```

**Test:** `apps/backend/src/features/bot-runtimes/socket-auth.test.ts` — table tests for missing token, wrong prefix, invalid key, missing scope, throw-during-validate, happy path.

## 5. Bot Socket Registry

**File (new):** `apps/backend/src/features/bot-runtimes/bot-socket-registry.ts`

Mirror of `apps/backend/src/lib/user-socket-registry.ts`. Tracks `(workspaceId, botId, instanceId) → Set<Socket>`. Exposes:

- `register(scope, socket)`
- `unregister(socket)`
- `count(scope): number`
- `isOnline(scope): boolean` — for online-status queries; preferred over `last_seen_at` on this backend instance

Plus a disconnect grace timer: on the last socket for a `(workspaceId, botId, instanceId)` going away, start a 30 s timer; if nothing reconnects in that window, call the supplied `onInstanceOffline(scope)` callback. Cancel the timer if any socket reconnects.

**Test:** `apps/backend/src/features/bot-runtimes/bot-socket-registry.test.ts` — register/unregister, grace timer triggers after 30 s of zero sockets, reconnect cancels the grace.

## 6. The `/bot` Namespace Handler

**File (new):** `apps/backend/src/features/bot-runtimes/socket-handler.ts`

```ts
export function registerBotSocketHandlers(
  io: Server,
  deps: {
    pool: Pool
    botApiKeyService: BotApiKeyService
    botRuntimeService: BotRuntimeService
    botSocketRegistry: BotSocketRegistry
  }
): Namespace {
  const ns = io.of("/bot")
  ns.use(createBotSocketAuthMiddleware({ botApiKeyService: deps.botApiKeyService }))

  ns.on("connection", (socket) => {
    const bot = socket.data.bot as ConnectedBot
    // Validated by middleware; safe to assume non-null.

    socket.on(
      "bot:hello",
      async (
        payload: {
          instanceId?: string
          runtimeSessionId?: string
          runtimeKind?: BotRuntimeKind
          publicKey?: string
          supportedCapabilities?: BotInvocationCapability[]
        },
        ack?: (result: { ok: true; bootstrap: BotBootstrap } | { ok: false; error: string }) => void
      ) => {
        // Validate via Zod (INV-55). Inline schema in this file, exported for tests.
        const parsed = botHelloSchema.safeParse(payload)
        if (!parsed.success) return ack?.({ ok: false, error: "Invalid bot:hello payload" })

        const { instanceId, runtimeSessionId, runtimeKind, publicKey, supportedCapabilities } = parsed.data

        // 1. Auto-join rooms FIRST. Order matters: if we read bootstrap before
        //    joining, an invocation inserted between SELECT and join would emit a
        //    push to an empty room and the bot would miss it until the safety-
        //    backstop poll. Joining first means the bot may see the same row in
        //    both the live push and the bootstrap snapshot — bot dedupes by
        //    invocationId. INV-53.
        socket.join(`bot:${bot.workspaceId}:${bot.botId}`)
        socket.join(`bot:${bot.workspaceId}:${bot.botId}:instance:${instanceId}`)

        // 2. Upsert presence (writes that persist). Same code path as POST /bot-runtime/presence.
        await deps.botRuntimeService.upsertPresenceFromBotKey({
          workspaceId: bot.workspaceId,
          botId: bot.botId,
          runtimeKind,
          instanceId,
          status: "available",
          acceptingInvocations: true,
          capabilities: { supportedCapabilities },
          // publicKey: handled by the e2e PR (#621) when that lands.
        })

        // 3. Register for disconnect-grace tracking.
        deps.botSocketRegistry.register({ workspaceId: bot.workspaceId, botId: bot.botId, instanceId }, socket)

        // 4. Compute and emit bootstrap.
        const bootstrap = await buildBotBootstrap(deps.pool, {
          workspaceId: bot.workspaceId,
          botId: bot.botId,
          instanceId,
          runtimeSessionId,
          supportedCapabilities,
        })

        ack?.({ ok: true, bootstrap })
      }
    )

    socket.on("disconnect", () => {
      deps.botSocketRegistry.unregister(socket)
      // Grace-period offline marking handled inside the registry.
    })
  })

  return ns
}
```

`buildBotBootstrap` lives in the same file and reads:

- Pending invocations:
  ```sql
  SELECT id, required_capability, created_at, target_instance_id, target_runtime_session_id
  FROM bot_invocations
  WHERE workspace_id = $1
    AND actor_id = $2
    AND (
      status = 'pending'
      OR (status = 'claimed' AND claimed_by_instance_id = $3)
    )
    AND (target_instance_id IS NULL OR target_instance_id = $3)
    AND (target_runtime_session_id IS NULL OR target_runtime_session_id = $4)
    AND required_capability = ANY($5)
  ORDER BY created_at
  LIMIT 100
  ```
  The `claimed_by_instance_id = $3` filter is the M5 security note: a reconnecting instance does not learn of claims held by siblings. The `pending` branch picks up untargeted work the reconnecting instance can still race for.
- Active actor map: `SELECT root_stream_id, actor_id FROM stream_active_actors WHERE workspace_id = $1 AND actor_type = 'bot' AND actor_id = $2`.
- Active session links for this instance: `SELECT runtime_session_id, root_stream_id, active_stream_id FROM bot_runtime_session_links WHERE workspace_id = $1 AND bot_id = $2 AND instance_id = $3 AND status = 'active'`.

All three are pure reads — pass `pool`, not `withClient` (INV-30).

### 6.1 The `bot:hello` Zod Schema

Critical: `instanceId` and `runtimeSessionId` become room-name fragments. Constrain them with a regex to prevent room-collision attacks (`instanceId: "../user:hacker"`).

```ts
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export const botHelloSchema = z.object({
  instanceId: z.string().regex(SAFE_ID, "instanceId must match [A-Za-z0-9_-]{1,64}"),
  runtimeSessionId: z.string().regex(SAFE_ID).optional(),
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  publicKey: z.string().max(512).optional(), // base64 X25519 pubkey for PR #621
  supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1).max(16),
})
```

`SAFE_ID` is intentionally narrow. ULIDs match it (`[0-9A-HJKMNP-TV-Z]{26}`), as do existing instanceId conventions in the bot SDK. Anything outside it is a client bug or an attack.

**Test:** `apps/backend/src/features/bot-runtimes/socket-handler.test.ts`. Use Socket.IO's in-process test harness (look at how `socket.ts` is tested today for the pattern). Cases:

- Connect without `bot:hello` → no rooms joined, no bootstrap emitted.
- Connect, send `bot:hello` → presence row exists, rooms joined, bootstrap returned with empty arrays when nothing pending.
- Insert a pending `bot_invocations` row, then connect + hello → bootstrap includes it.
- Insert a row with `targetInstanceId = X`; connect with `instanceId = X` → row included; connect with `instanceId = Y` → row excluded.
- After `bot:hello`, insert a new untargeted row via the service (which now writes an outbox event) → run the broadcast handler tick → socket receives `bot_invocation:available`.

## 7. Per-Socket Key Re-Validation Ticker

**No periodic `last_seen_at` ticker.** We deliberately do NOT write `last_seen_at` on a schedule — the WS connection itself is the truth, surfaced via `BotSocketRegistry.isOnline(scope)`. Two truths would drift. `last_seen_at` is written on `bot:hello`, on `markOffline` (after grace), and on explicit `POST /bot-runtime/presence`. That's it.

**What we do add (security):** A per-socket key-revalidation ticker. `BotApiKeyService.validateKey` has no cache today (`bot-api-key-service.ts:146-171` always hits the DB), so HTTP revocation is immediate. Without this ticker, a revoked key keeps receiving `bot_invocation:available` pushes until the socket's ping-timeout (~60 s). Adding one DB lookup every 60 s per connected socket is cheap and closes the hole.

```ts
ns.on("connection", (socket) => {
  // … bot:hello handler above …

  const revalidateId = setInterval(async () => {
    try {
      const stillValid = await deps.botApiKeyService.validateKey(socket.handshake.auth.token)
      if (!stillValid) socket.disconnect(true)
    } catch (err) {
      logger.warn({ err, socketId: socket.id }, "Bot key revalidate failed; disconnecting")
      socket.disconnect(true)
    }
  }, 60_000)

  socket.on("disconnect", () => {
    clearInterval(revalidateId)
    deps.botSocketRegistry.unregister(socket)
  })
})
```

The validator already runs hot on the request path; one extra read per minute per socket is rounding error at single-user scale and stays well below `BotApiKeyService`'s implicit budget at multi-user scale.

**Test:** Inject a fake `botApiKeyService` whose `validateKey` returns `null` after the third call; assert the socket disconnects on the 4th tick. Use `vi.useFakeTimers()`.

## 8. Wire Everything in `server.ts`

**File:** `apps/backend/src/server.ts` (around the existing `registerSocketHandlers(io, …)` and `registerVoiceGateway(io, …)` calls).

```ts
const botSocketRegistry = new BotSocketRegistry({
  onInstanceOffline: async (scope) => {
    await BotRuntimeInstanceRepository.markOffline(pools.main, scope)
  },
  graceMs: 30_000,
})

// IMPORTANT: every backend instance must call this at boot. @socket.io/postgres-adapter
// fans out per-namespace; if instance A never registers /bot, broadcasts from B silently
// no-op on A's sockets. Do not introduce per-instance gating for this namespace.
const botGateway = registerBotSocketHandlers(io, {
  pool: pools.main,
  botApiKeyService,
  botRuntimeService,
  botSocketRegistry,
})

// Pass botGateway.namespace into BroadcastHandler so it can emit on /bot.
const broadcastHandler = new BroadcastHandler({ io, botNamespace: botGateway.namespace, … })

// Graceful shutdown:
shutdownHooks.push(async () => { botGateway.stop(); })
```

Add `BotRuntimeInstanceRepository.markOffline` (new method): a single UPDATE that sets `status='offline'`, `accepting_invocations=false`, `last_seen_at=NOW()`. **Must NOT delete the row** — `BotInvocationRepository.claimOne` requires `EXISTS (… FROM bot_runtime_instances WHERE instance_id = …)` for `target_instance_id`-pinned invocations to remain claimable when the instance reconnects later. The `EXISTS` check does not filter on `status`, so an offline-but-present row stays claimable on reconnect; a deleted row would not.

## 9. Active-Actor Mutation Discipline

**Files:** `apps/backend/src/features/bot-runtimes/service.ts`, `apps/backend/src/features/bot-runtimes/repository.ts`.

`bot:active_actor:changed` outbox events are emitted exclusively from a new `BotRuntimeService.setActiveActorInTransaction(db, params)` wrapper around `StreamActiveActorRepository.upsert`. Both current callers route through it:

- `BotRuntimeService.setActiveActor` (the public single-shot path) calls it inside `withTransaction`.
- `BotRuntimeService.createOrLinkPiRemoteSessionInTransaction` already inside a `withTransaction`; switches its direct `StreamActiveActorRepository.upsert` call to `setActiveActorInTransaction`.

The wrapper:

1. Reads the existing row inside the same tx (`StreamActiveActorRepository.findByRootStream`) to compute `previousActorType` / `previousActorId`.
2. Upserts the new actor.
3. If the actor identity actually changed (not a no-op update), emits `bot:active_actor:changed` with `affectedBotIds = [previous, new].filter(isBotActor).map(id => id)`.

Add a comment to `StreamActiveActorRepository.upsert` pointing at the service wrapper: "Do not call this directly from outside this feature. Go through `BotRuntimeService.setActiveActorInTransaction` so the outbox event fires."

**Test:** `service.test.ts` — change actor twice; assert two outbox events with correct `affectedBotIds`. Upsert with no change → no second event.

## 10. Echo `wsUrl` in `POST /bot-runtime/presence` (Discovery)

**File:** `apps/backend/src/features/public-api/handlers.ts` — in `upsertBotRuntimePresence`, include `wsUrl` in the response body so the bot SDK gets it on its very first HTTP call:

```ts
return res.json({
  instance: presence,
  wsUrl: deps.regionWsUrl, // injected at handler factory time
})
```

`regionWsUrl` is read from env (`WS_URL` or similar — match whatever the frontend config endpoint uses today). Older bots ignore the extra field; new bots use it instead of hitting `GET /api/workspaces/:id/config` separately. Saves one worker invocation on bot startup.

## 11. Test Plan Summary

| Layer         | File                                                                      | What                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox types  | `apps/backend/src/lib/outbox/*.test.ts`                                   | Type-only; ensure existing tests pass                                                                                                          |
| Service       | `apps/backend/src/features/bot-runtimes/service.test.ts`                  | `createInvocation` writes one row + one outbox event per fresh insert; second call with same key writes no event                               |
| Active actor  | `apps/backend/src/features/bot-runtimes/service.test.ts` (step 9)         | `setActiveActorInTransaction` emits `bot:active_actor_changed` only when identity changes; `affectedBotIds` covers both old and new bot actors |
| Broadcast     | `apps/backend/src/lib/outbox/broadcast-handler.test.ts`                   | Bot events route to `bot:` rooms on `/bot` namespace                                                                                           |
| Socket auth   | `apps/backend/src/features/bot-runtimes/socket-auth.test.ts`              | Reject missing/invalid/throw; accept valid                                                                                                     |
| Registry      | `apps/backend/src/features/bot-runtimes/bot-socket-registry.test.ts`      | Register/unregister/grace-timer                                                                                                                |
| Handler       | `apps/backend/src/features/bot-runtimes/socket-handler.test.ts`           | Full lifecycle: connect → hello → bootstrap → push → disconnect                                                                                |
| Revalidation  | `apps/backend/src/features/bot-runtimes/socket-handler.test.ts` (step 7)  | Faked `validateKey` returns `null` after N ticks; socket disconnects on the next 60 s tick                                                     |
| Presence echo | `apps/backend/src/features/public-api/handlers.test.ts` (step 10)         | `POST /bot-runtime/presence` response body includes `wsUrl` from injected `regionWsUrl`                                                        |
| Integration   | `apps/backend/src/features/bot-runtimes/socket-integration.test.ts` (new) | End-to-end via real Postgres: insert message → outbox → invocation row → outbox push → socket receives event                                   |

Run `bun run test` after each step. Stop and triage failures immediately (INV-22). If you isolate a flake to an unrelated suite, note it in the PR description rather than ignoring it.

## 12. Files Created / Modified — Cheat Sheet

**New:**

- `apps/backend/src/features/bot-runtimes/socket-auth.ts`
- `apps/backend/src/features/bot-runtimes/socket-handler.ts`
- `apps/backend/src/features/bot-runtimes/bot-socket-registry.ts`
- Plus four test files above.

**Modified:**

- `apps/backend/src/lib/outbox/repository.ts` — event types + payloads + `BOT_SCOPED_EVENTS`
- `apps/backend/src/lib/outbox/broadcast-handler.ts` — `dispatchBotEvent` branch, accept `botNamespace` dep
- `apps/backend/src/features/bot-runtimes/service.ts` — `createInvocationInTransaction` (emits `bot_invocation:available`), `setActiveActorInTransaction` (emits `bot:active_actor_changed`), `createOrLinkPiRemoteSessionInTransaction` routes through the wrapper
- `apps/backend/src/features/bot-runtimes/repository.ts` — `BotInvocationRepository.insertIdempotent` returns `wasNewlyInserted`, `claimOne` emits `bot_invocation:claimed`, `BotRuntimeInstanceRepository.markOffline` (new)
- `apps/backend/src/features/bot-runtimes/index.ts` — export new public surface (INV-52)
- `apps/backend/src/server.ts` — instantiate registry, register `/bot` namespace, pass to broadcaster, graceful shutdown hook
- `apps/backend/src/features/public-api/handlers.ts` — `upsertBotRuntimePresence` response body includes `wsUrl`

**New scripts:**

- `scripts/smoke-bot-ws.ts` — see §13. Pure dev tool; not shipped, not imported.

**Not touched:**

- Any HTTP route or handler logic (claim/complete/fail/steps stay exactly as-is)
- `apps/workspace-router` (worker pass-through is already path-based)
- `apps/frontend` (no frontend changes in this PR)
- Bot SDK / Pi runtime (client adoption is a separate PR)

## 13. Manual Smoke Test (Pre-merge)

Socket.IO multiplexes namespaces and ack callbacks over Engine.IO frames, so `wscat` won't work — `--auth-token` is not a wscat flag and even if it were, the raw `42[…]` framing would be rejected without an Engine.IO handshake. Use the in-repo `socket.io-client` instead.

```sh
# Terminal 1: backend
bun run dev:backend

# Terminal 2: create or look up a bot key with BOT_RUNTIME_WRITE scope
# (existing tooling — bot key creation is unchanged). Export it for the script:
export THREA_BOT_KEY=threa_bk_…
export THREA_BACKEND_URL=http://localhost:4000

# Terminal 3: smoke client (bun runs TS directly; socket.io-client is already in the workspace)
bun run scripts/smoke-bot-ws.ts
```

Where `scripts/smoke-bot-ws.ts` is:

```ts
import { io } from "socket.io-client"

const url = process.env.THREA_BACKEND_URL ?? "http://localhost:4000"
const token = process.env.THREA_BOT_KEY
if (!token) throw new Error("Set THREA_BOT_KEY")

const socket = io(`${url}/bot`, {
  transports: ["websocket"],
  auth: { token },
})

socket.on("connect", () => {
  console.log("[smoke] connected", socket.id)
  socket.emit(
    "bot:hello",
    {
      instanceId: "smoke",
      runtimeKind: "pi-local",
      supportedCapabilities: ["mentionable", "active-scratchpad"],
    },
    (result: unknown) => {
      console.log("[smoke] bot:hello ack →", JSON.stringify(result, null, 2))
    }
  )
})

socket.on("connect_error", (err) => console.error("[smoke] connect_error", err.message))
socket.on("bot_invocation:available", (payload) => console.log("[smoke] available →", payload))
socket.on("bot_invocation:claimed", (payload) => console.log("[smoke] claimed →", payload))
socket.on("bot_invocation:cancelled", (payload) => console.log("[smoke] cancelled →", payload))
socket.on("bot_session_link:invalidated", (payload) => console.log("[smoke] link_invalidated →", payload))
socket.on("bot:active_actor_changed", (payload) => console.log("[smoke] active_actor →", payload))
socket.on("disconnect", (reason) => console.log("[smoke] disconnect", reason))
```

Expected output:

1. `[smoke] connected …`
2. `[smoke] bot:hello ack → { ok: true, bootstrap: { pendingInvocations: [], … } }`
3. From a fourth terminal, post a message that mentions the bot (existing HTTP or UI). Terminal 3 prints `[smoke] available → { invocationId: …, requiredCapability: "mentionable", … }`.

Negative cases worth running once:

- Unset `THREA_BOT_KEY`, rerun → `connect_error: Missing bot API key`.
- Set `THREA_BOT_KEY=garbage`, rerun → `connect_error: Invalid bot API key`.
- Set `THREA_BOT_KEY` to a key without `BOT_RUNTIME_WRITE` scope → `connect_error: Insufficient scope`.

Capture stdout for the PR description as proof. If the push doesn't arrive after a mention, check in order: outbox dispatcher running, `BroadcastHandler` got the new bot branch, `botNamespace` passed in correctly at `server.ts`, room name matches `bot:{workspaceId}:{botId}`.
