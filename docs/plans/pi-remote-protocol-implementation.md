# Minimal bot invocation protocol and Pi remote implementation plan

## Context

This plan turns the high-level model in [`interactive-bot-scratchpads.md`](./interactive-bot-scratchpads.md) into a minimal, reviewable implementation that can replace the current global Pi polling plugin at `~/.pi/agent/extensions/threa-remote.ts`.

The current plugin works for a personal prototype, but it has the wrong long-term shape:

- every configured Pi instance polls the same Threa stream,
- messages are detected by ad-hoc `/pi ...` text parsing rather than provider-neutral invocation records,
- there is no atomic claim/dedupe protocol,
- there is no runtime presence/handshake,
- the Pi session binding lives only in local JSON, so Threa cannot show whether the active runtime is online,
- a Threa-created "new Pi session" would imply spawning/managing local processes, which is OpenClaw-shaped work and should not be built into Threa's minimal Pi adapter.

## Recommended V1 product shape

Use a **Pi-session-initiated remote-control flow** for local Pi and Claude-Code-channel-style runtimes.

```text
User opens Pi in the repo/session they want to expose
  ↓
User runs /remote-control in Pi
  ↓
Pi heartbeats a runtime instance and asks Threa to create/link a dedicated scratchpad
  ↓
Threa creates "Pi Remote: <cwd/session>" for the bot owner,
attaches that personal bot as the active actor,
grants the bot access to the scratchpad root,
and binds the scratchpad to this Pi instance/session
  ↓
User chats in Threa scratchpad
  ↓
Threa creates targeted BotInvocation rows
  ↓
Only the linked Pi instance can claim those rows
```

This avoids building a bad OpenClaw clone. Threa can create a chat surface and route invocations, but it does **not** spawn local processes or decide local worktree/session policy. If a future product needs "start a fresh coding agent from Threa", that is the OpenClaw integration path.

A later phase can add a Threa-first pairing flow for an already-open Pi session:

```text
User creates/selects a Pi bot scratchpad in Threa
  ↓
User runs /remote-control --pair in Pi, receives a short code
  ↓
User runs /link-pi-remote <code> in that Threa scratchpad
  ↓
Threa binds the existing scratchpad to that Pi instance/session
```

That flow is useful, but it should not block V1. It is also the likely shape for Claude Code channels, because the MCP/channel server must run inside an already-active local session.

## Protocol invariants

- **Workspace is always part of every key.** Runtime session keys and claims must include `workspaceId` to avoid cross-workspace collisions.
- **The bot API key is the runtime identity.** Threa verifies that a runtime claiming an invocation is authenticated as the target bot.
- **Presence is advisory.** Atomic invocation claims and stream access checks remain the security boundary.
- **Invocations are provider-neutral.** Pi, Hermes, OpenClaw, and Claude Code channels all consume the same `BotInvocation` shape.
- **Active scratchpad bindings target local instances.** A Pi active scratchpad should carry a session link with `targetInstanceId`; unlinked or offline scratchpads should fail visibly instead of being consumed by a random Pi process.
- **Adapters never poll arbitrary messages.** They heartbeat and claim invocations. Threa owns message → invocation resolution.
- **No rich runtime blobs in message metadata.** Use metadata only for small external ids such as `pi.remote.invocationId`; typed runtime artifacts can come later.

## Stacked PR plan

Each phase should be a separate PR stacked on the previous one. For every phase:

1. Plan the phase in the PR description.
2. Build the smallest complete slice.
3. Self-review for correctness, security, concurrency, and UX.
4. Run focused tests plus repo typecheck/lint as appropriate.
5. Create the PR.
6. Before starting the next phase, check the previous PR for CodeRabbit/GitHub Actions failures and address valid feedback.

---

## Phase 1 — Backend protocol primitives

### Goal

Add storage, constants, repositories, and service methods for bot capabilities, active scratchpad bindings, runtime presence, runtime session links, and provider-neutral invocation claims. This PR should not change frontend UX and should not yet invoke Pi.

### Suggested files

| File                                                                     | Change                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `packages/types/src/constants.ts`                                        | Add explicit bot traits and runtime/invocation constants                              |
| `packages/types/src/domain.ts`                                           | Add exported runtime/invocation domain types if frontend/public API clients need them |
| `packages/backend-common/src/id.ts`                                      | Add id helpers for invocation/runtime rows                                            |
| `apps/backend/src/lib/id.ts`                                             | Re-export new id helpers                                                              |
| `apps/backend/src/db/migrations/<timestamp>_bot_runtime_invocations.sql` | Add protocol tables                                                                   |
| `apps/backend/src/features/bot-runtimes/repository.ts`                   | Data access for active actors, presence, session links, invocations                   |
| `apps/backend/src/features/bot-runtimes/service.ts`                      | Transaction-owning domain operations                                                  |
| `apps/backend/src/features/bot-runtimes/index.ts`                        | Feature barrel                                                                        |
| `apps/backend/src/features/bot-runtimes/*.test.ts`                       | Repository/service tests for claim races, idempotency, workspace scoping              |

### Trait constants

Replace the coarse `interactive` capability with explicit traits. There is no compatibility alias in the runtime path; any prototype/dev rows that still contain `interactive` should be rewritten by migration.

```ts
// packages/types/src/constants.ts
export const BOT_TRAITS = ["mentionable", "active-scratchpad"] as const
export type BotTrait = (typeof BOT_TRAITS)[number]

export const BotTraits = {
  MENTIONABLE: "mentionable",
  ACTIVE_SCRATCHPAD: "active-scratchpad",
} as const satisfies Record<string, BotTrait>

export const BOT_RUNTIME_KINDS = ["pi-local", "hermes", "openclaw", "claude-code-channel", "custom"] as const
export type BotRuntimeKind = (typeof BOT_RUNTIME_KINDS)[number]

export const BOT_RUNTIME_STATUSES = ["available", "busy", "offline", "error"] as const
export type BotRuntimeStatus = (typeof BOT_RUNTIME_STATUSES)[number]

export const BOT_INVOCATION_STATUSES = ["pending", "claimed", "completed", "failed", "cancelled", "expired"] as const
export type BotInvocationStatus = (typeof BOT_INVOCATION_STATUSES)[number]

export const BOT_INVOCATION_TRIGGERS = ["mention", "active-scratchpad"] as const
export type BotInvocationTrigger = (typeof BOT_INVOCATION_TRIGGERS)[number]

export const BOT_INVOCATION_CAPABILITIES = ["mentionable", "active-scratchpad"] as const
export type BotInvocationCapability = (typeof BOT_INVOCATION_CAPABILITIES)[number]
```

Use a helper only for readability at call sites:

```ts
export function botHasCapability(bot: { traits: readonly BotTrait[] }, capability: BotInvocationCapability): boolean {
  return bot.traits.includes(capability)
}
```

### Migration sketch

Do not add foreign keys or DB enums. Keep all rows workspace-scoped and validate text vocabularies in application code.

```sql
CREATE TABLE stream_active_actors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  actor_type TEXT NOT NULL, -- 'persona' | 'bot'
  actor_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, root_stream_id)
);

CREATE INDEX idx_stream_active_actors_actor
  ON stream_active_actors (workspace_id, actor_type, actor_id);

CREATE TABLE bot_runtime_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL,
  accepting_invocations BOOLEAN NOT NULL DEFAULT FALSE,
  capabilities JSONB NOT NULL DEFAULT '{}',
  status_text TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, bot_id, instance_id)
);

CREATE INDEX idx_bot_runtime_instances_lookup
  ON bot_runtime_instances (workspace_id, bot_id, status, accepting_invocations);

CREATE TABLE bot_runtime_session_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  active_stream_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'paused' | 'ended'
  linked_by TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, bot_id, root_stream_id, active_stream_id),
  UNIQUE (workspace_id, bot_id, runtime_kind, instance_id, runtime_session_id)
);

CREATE INDEX idx_bot_runtime_session_links_instance
  ON bot_runtime_session_links (workspace_id, bot_id, instance_id, status);

CREATE TABLE bot_invocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  root_stream_id TEXT NOT NULL,
  active_stream_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  response_stream_id TEXT NOT NULL,
  actor_type TEXT NOT NULL, -- V1 external adapter rows should be 'bot'
  actor_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  required_capability TEXT NOT NULL,
  prompt_markdown TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  mentioned_actor_slugs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  target_instance_id TEXT,
  target_runtime_session_id TEXT,
  claimed_by_instance_id TEXT,
  claim_token TEXT,
  claim_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, source_message_id, actor_type, actor_id, trigger)
);

CREATE INDEX idx_bot_invocations_claimable
  ON bot_invocations (workspace_id, actor_id, status, created_at)
  WHERE status IN ('pending', 'claimed');

CREATE INDEX idx_bot_invocations_source_message
  ON bot_invocations (workspace_id, source_message_id);

-- One-way cleanup for any prototype/dev rows created before the split.
-- Do not keep `interactive` as a runtime alias.
UPDATE bots
SET traits = ARRAY(
  SELECT DISTINCT unnest(array_remove(traits, 'interactive') || ARRAY['mentionable', 'active-scratchpad']::text[])
)
WHERE 'interactive' = ANY(traits);
```

### Repository claim pattern

The claim path is the most important correctness boundary. It must be a single atomic update, not select-then-update.

```ts
async claimOne(
  db: Querier,
  params: {
    workspaceId: string
    botId: string
    instanceId: string
    claimToken: string
    supportedCapabilities: BotInvocationCapability[]
    claimTtlSeconds: number
  }
): Promise<BotInvocation | null> {
  const result = await db.query<BotInvocationRow>(sql`
    WITH candidate AS (
      SELECT id
      FROM bot_invocations
      WHERE workspace_id = ${params.workspaceId}
        AND actor_type = 'bot'
        AND actor_id = ${params.botId}
        AND required_capability = ANY(${params.supportedCapabilities})
        AND (target_instance_id IS NULL OR target_instance_id = ${params.instanceId})
        AND (
          status = 'pending'
          OR (status = 'claimed' AND claim_expires_at < NOW())
        )
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE bot_invocations i
    SET status = 'claimed',
        claimed_by_instance_id = ${params.instanceId},
        claim_token = ${params.claimToken},
        claim_expires_at = NOW() + (${params.claimTtlSeconds} || ' seconds')::interval,
        attempts = attempts + 1,
        updated_at = NOW()
    FROM candidate
    WHERE i.id = candidate.id
    RETURNING i.*
  `)
  return result.rows[0] ? mapInvocationRow(result.rows[0]) : null
}
```

Completion must verify both `claimed_by_instance_id` and `claim_token` so a stale local process cannot complete a re-claimed invocation.

### Service responsibilities

`BotRuntimeService` should own transactions for cross-table operations:

- `upsertPresenceFromBotKey(...)`
- `createOrLinkPiRemoteSession(...)`
- `createInvocation(...)`
- `claimNextInvocation(...)`
- `completeInvocation(...)`
- `failInvocation(...)`
- `expireStaleClaims(...)` if needed later

### Self-review checklist

- Does every table and query include `workspace_id`?
- Are writes idempotent where they may be retried?
- Is claiming a single SQL statement with `FOR UPDATE SKIP LOCKED`?
- Are stale claims reclaimable only after `claim_expires_at`?
- Can a bot key only claim invocations for its own bot id?
- Does the migration remove/replace any prototype `interactive` rows instead of preserving a runtime alias?

### Validation

- Repository tests for duplicate invocation insert, presence upsert, and concurrent claim.
- `bun run --cwd apps/backend test -- bot-runtimes`
- `bun run --cwd packages/types typecheck`
- `bun run --cwd apps/backend typecheck`

---

## Phase 2 — Public runtime API and bot stream access inheritance

### Goal

Expose a narrow public API for runtime adapters and make bot access grants work for scratchpad-rooted threads.

### Suggested files

| File                                                                            | Change                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/types/src/workspace-permissions.ts`                                   | Add API-key scopes for runtime invocation/presence                            |
| `packages/types/src/api-keys.ts`                                                | Include the new scopes in `API_KEY_ELIGIBLE_SCOPES` if selectable by bot keys |
| `apps/backend/src/features/public-api/schemas.ts`                               | Add runtime request schemas                                                   |
| `apps/backend/src/features/public-api/routes.ts`                                | Add OpenAPI route definitions and response schemas                            |
| `apps/backend/src/features/public-api/handlers.ts` or `bot-runtime-handlers.ts` | Add handlers; prefer a separate file if `handlers.ts` grows too much          |
| `apps/backend/src/routes.ts`                                                    | Register public API routes with `requireApiKeyScope(...)`                     |
| `apps/backend/src/features/api-keys/service.ts`                                 | Treat explicit root grants as access to descendant threads for bots           |
| `apps/backend/src/features/api-keys/repository.ts`                              | Add efficient root/ancestor grant lookup if needed                            |
| `apps/backend/src/features/public-api/*.test.ts`                                | API tests for auth/scope/ownership                                            |

### New public API scopes

Suggested scope names:

```ts
WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_READ = "bot-runtime:read"
WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE = "bot-runtime:write"
WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_READ = "bot-invocations:read"
WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE = "bot-invocations:write"
```

If scope sprawl feels too heavy for V1, collapse to:

```ts
WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS = "bot-invocations"
```

but keep read/write split in the handler code so it can be split later without large rewrites.

### Runtime endpoints

All endpoints below are authenticated with public API keys. V1 should require **bot-scoped keys** for claim/complete/fail/session-link routes. User-scoped keys can be added later for admin dashboards.

```text
POST /api/v1/workspaces/:workspaceId/bot-runtime/presence
POST /api/v1/workspaces/:workspaceId/bot-runtime/sessions
POST /api/v1/workspaces/:workspaceId/bot-invocations/claim
POST /api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/heartbeat
POST /api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/complete
POST /api/v1/workspaces/:workspaceId/bot-invocations/:invocationId/fail
```

#### Presence request

```ts
const upsertPresenceSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  displayName: z.string().max(100).optional(),
  status: z.enum(BOT_RUNTIME_STATUSES),
  acceptingInvocations: z.boolean(),
  capabilities: z
    .object({
      supportsMentionInvocations: z.boolean().optional(),
      supportsActiveScratchpad: z.boolean().optional(),
      supportsPersistentSessions: z.boolean().optional(),
      supportsStop: z.boolean().optional(),
      supportsPermissionRelay: z.boolean().optional(),
      supportsStreaming: z.boolean().optional(),
    })
    .optional()
    .default({}),
  statusText: z.string().max(200).optional(),
})
```

#### Create/link Pi remote session request

This is the endpoint used by Pi `/remote-control`. It is intentionally bot-key scoped and limited to personal bots in V1.

```ts
const createRuntimeSessionSchema = z.object({
  runtimeKind: z.literal("pi-local"),
  instanceId: z.string().min(1).max(128),
  runtimeSessionId: z.string().min(1).max(256),
  displayName: z.string().min(1).max(100).optional(),
  localCwd: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
})
```

Response:

```ts
type RuntimeSessionResponse = {
  data: {
    linkId: string
    workspaceId: string
    botId: string
    rootStreamId: string
    activeStreamId: string
    responseStreamId: string
    runtimeKind: "pi-local"
    instanceId: string
    runtimeSessionId: string
    streamUrlPath: string // e.g. /w/:workspaceId/s/:rootStreamId
  }
}
```

Server behavior:

1. Verify `req.botApiKey` exists.
2. Fetch the bot by `workspaceId + botId`.
3. Require `bot.type === "personal"` for V1.
4. Require `botHasCapability(bot, "active-scratchpad")`.
5. Create or reuse a scratchpad owned by `bot.ownerUserId` and named `Pi Remote: <displayName>`.
6. Insert/upsert `stream_active_actors` for the scratchpad root.
7. Grant the bot access to the scratchpad root via the existing bot stream grant table.
8. Insert/upsert `bot_runtime_session_links` with `instanceId + runtimeSessionId`.
9. Return the stream id/path.

Implementation note: do this in a `BotRuntimeService` transaction with repositories directly. Do **not** call `StreamService.createScratchpad()` inside another transaction unless `StreamService` is refactored to accept a caller-owned transaction.

#### Claim request

```ts
const claimInvocationSchema = z.object({
  runtimeKind: z.enum(BOT_RUNTIME_KINDS),
  instanceId: z.string().min(1).max(128),
  supportedCapabilities: z.array(z.enum(BOT_INVOCATION_CAPABILITIES)).min(1),
  claimTtlSeconds: z.number().int().min(15).max(300).optional().default(60),
})
```

Response includes at most one invocation for V1. Keeping it one-at-a-time makes local Pi busy handling simple.

```ts
type ClaimedInvocationResponse = {
  data: null | {
    id: string
    workspaceId: string
    rootStreamId: string
    activeStreamId: string
    sourceMessageId: string
    responseStreamId: string
    actor: { type: "bot"; id: string; slug: string }
    trigger: "active-scratchpad" | "mention"
    requiredCapability: "active-scratchpad" | "mentionable"
    promptMarkdown: string
    authorUserId: string
    mentionedActorSlugs: string[]
    claimToken: string
    claimExpiresAt: string
    runtimeSessionId: string | null
  }
}
```

#### Complete request

Let the completion endpoint post the final bot message and mark the invocation complete in one transaction.

```ts
const completeInvocationSchema = z.object({
  instanceId: z.string().min(1).max(128),
  claimToken: z.string().min(1).max(256),
  finalMessageMarkdown: z.string().min(1).max(50_000),
  metadata: messageMetadataSchema.optional(),
})
```

Server behavior:

1. Verify invocation belongs to `workspaceId` and target bot id from `req.botApiKey`.
2. Verify `status === "claimed"`, `claimed_by_instance_id`, `claim_token`, and non-expired claim.
3. Verify bot still has access to `responseStreamId`.
4. Create the bot message in `responseStreamId`.
5. Mark invocation `completed` with `completed_at`.

### Bot access inheritance for threads

The existing table is called `bot_channel_access`, but it stores `stream_id`. For minimal implementation, keep the table and service names to avoid a rename PR, but make access semantics stream-root aware:

```ts
async isStreamAccessibleForBot(workspaceId: string, botId: string, streamId: string): Promise<boolean> {
  const stream = await StreamRepository.findById(this.pool, streamId)
  if (!stream || stream.workspaceId !== workspaceId || stream.archivedAt) return false

  if (stream.visibility === "public") return true

  if (await BotChannelAccessRepository.hasGrant(this.pool, workspaceId, botId, stream.id)) return true

  if (stream.rootStreamId) {
    return BotChannelAccessRepository.hasGrant(this.pool, workspaceId, botId, stream.rootStreamId)
  }

  return false
}
```

`getAccessibleStreamIdsForBot` should also include descendant threads of granted roots if adapters need list/search across threads. If that is expensive, keep V1 precise for `isStreamAccessibleForBot` and add a repository method that expands granted roots using a set-based query.

### Self-review checklist

- Can a user-scoped API key claim bot invocations? It should not in V1.
- Can a bot key create a remote scratchpad for someone other than its owner? It should not.
- Can a shared bot create personal scratchpads? Defer; reject in V1.
- Are scope checks registered in `routes.ts` and documented in `PUBLIC_API_ROUTES`?
- Does OpenAPI generation pass?
- Do bot thread access checks cover scratchpad-rooted threads?

### Validation

- Public API tests for presence, session creation, claim, complete, fail.
- Access tests for root scratchpad grant → descendant thread read/write.
- `bun apps/backend/scripts/generate-api-docs.ts --check` after route registry updates.

---

## Phase 3 — Active bot invocation producer

### Goal

Create `BotInvocation` rows from user-authored messages in active bot scratchpads. This is the first phase where Threa messages become runtime work, but the old Pi plugin can still coexist.

### Suggested files

| File                                                                       | Change                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| `apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts`      | New outbox listener for `message:created`               |
| `apps/backend/src/features/bot-runtimes/active-actor-repository.ts`        | Active actor lookup by root stream                      |
| `apps/backend/src/features/bot-runtimes/service.ts`                        | Invocation creation and active actor resolution helpers |
| `apps/backend/src/server.ts`                                               | Register the new outbox handler                         |
| `apps/backend/src/features/bot-runtimes/invocation-outbox-handler.test.ts` | Suppression, dedupe, thread inheritance tests           |

### V1 activation scope

Keep this phase intentionally narrow:

- support active bot scratchpads and scratchpad-rooted threads,
- ignore bot/persona/system-authored messages,
- suppress active auto-invocation when explicit mentionable actor mentions exist,
- do not yet implement arbitrary channel `@bot` mention invocation unless it fits comfortably.

Mentionable bot support can be a follow-up PR using the same invocation table.

### Active actor resolution

```ts
async function resolveActiveBotActor(db: Querier, stream: Stream) {
  const rootStreamId = stream.rootStreamId ?? stream.id
  const root = rootStreamId === stream.id ? stream : await StreamRepository.findById(db, rootStreamId)
  if (!root || root.type !== StreamTypes.SCRATCHPAD) return null

  const active = await StreamActiveActorRepository.findByRootStream(db, stream.workspaceId, root.id)
  if (!active || active.actorType !== "bot") return null

  const bot = await BotRepository.findById(db, stream.workspaceId, active.actorId)
  if (!bot || bot.archivedAt || !botHasCapability(bot, "active-scratchpad")) return null

  return { rootStream: root, bot }
}
```

### Invocation creation sketch

```ts
if (messageEvent.actorType !== AuthorTypes.USER) return seen

const stream = await StreamRepository.findById(db, streamId)
if (!stream || stream.archivedAt) return seen

const mentionedSlugs = extractMentionSlugs(messageEvent.payload.contentMarkdown)
const mentionedBots = await resolveMentionableBotsVisibleToAuthor(db, {
  workspaceId,
  authorUserId: messageEvent.actorId,
  slugs: mentionedSlugs,
})

const active = await resolveActiveBotActor(db, stream)

// Mention suppression: if any explicit mentionable actor is present, do not
// auto-invoke the active actor unless that active actor was explicitly mentioned.
const activeMentioned = active?.bot.slug != null && mentionedSlugs.includes(active.bot.slug)
const shouldInvokeActive = active && (mentionedBots.length === 0 || activeMentioned)

if (shouldInvokeActive) {
  const link = await BotRuntimeSessionRepository.findActiveByStream(db, {
    workspaceId,
    botId: active.bot.id,
    rootStreamId: active.rootStream.id,
    activeStreamId: stream.id,
  })

  await BotInvocationRepository.insertIdempotent(db, {
    id: botInvocationId(),
    workspaceId,
    rootStreamId: active.rootStream.id,
    activeStreamId: stream.id,
    sourceMessageId: messageEvent.payload.messageId,
    responseStreamId: stream.id,
    actorType: "bot",
    actorId: active.bot.id,
    trigger: "active-scratchpad",
    requiredCapability: "active-scratchpad",
    promptMarkdown: messageEvent.payload.contentMarkdown,
    authorUserId: messageEvent.actorId,
    mentionedActorSlugs: mentionedSlugs,
    targetInstanceId: link?.instanceId ?? null,
    targetRuntimeSessionId: link?.runtimeSessionId ?? null,
    metadata: {},
  })
}
```

If `link` is missing, either:

- create the invocation with no `targetInstanceId` and let any eligible Pi claim it, **or**
- create a failed/offline notice.

For Pi V1, prefer **failed/offline notice** for active scratchpads that are expected to be bound to one local session. Untargeted active-scratchpad claims are how multiple Pi instances accidentally consume the wrong scratchpad.

### Offline behavior

Minimal V1 can be:

- if no active session link exists: create a bot/system notice like "Pi is not linked to this scratchpad. Run `/remote-control` in Pi to link a session." and do not create a claimable invocation;
- if a link exists but presence is stale/offline: create an invocation targeted to that instance, allow a short pending window, then mark expired/offline via a cleanup worker or the next claim attempt.

Do not silently drop the message.

### Self-review checklist

- Does the handler ignore bot-authored messages to avoid loops?
- Does it dedupe via `UNIQUE (workspace_id, source_message_id, actor_type, actor_id, trigger)`?
- Does it include `workspaceId + rootStreamId + activeStreamId + actor.id` in session lookup?
- Does mention suppression match the high-level plan?
- Do scratchpad-rooted threads inherit the active actor but reply in the current thread?

### Validation

- Unit tests for:
  - user message in active bot scratchpad creates one invocation,
  - bot message creates no invocation,
  - descendant thread creates invocation with root scratchpad + active thread ids,
  - explicit `@ariadne` suppresses active bot invocation,
  - duplicate outbox processing does not create duplicate invocations.

---

## Phase 4 — Rewrite the global Pi remote extension against the protocol

### Goal

Replace ad-hoc stream polling with a Pi extension that:

- registers `/remote-control`,
- heartbeats runtime presence,
- creates/links one dedicated Threa scratchpad for this Pi session,
- claims only targeted invocation rows,
- injects a claimed invocation into Pi,
- completes/fails the invocation through the public runtime API.

This phase can be developed outside the repo as the global file, but the PR should include a checked-in reference copy or documentation snippet so reviewers can evaluate the protocol.

Suggested repo location for the reference copy:

```text
docs/examples/pi-remote/threa-remote-v2.ts
```

### Local config

The existing config can evolve from fixed `streamId` to runtime-session state.

```ts
type Config = {
  baseUrl: string
  workspaceId: string
  apiKey: string // bot-scoped key
  pollMs?: number
  instanceId?: string
  defaultDisplayName?: string
  linkedSessions?: Record<
    string,
    {
      linkId: string
      rootStreamId: string
      activeStreamId: string
      runtimeSessionId: string
      streamUrlPath: string
    }
  >
}
```

Generate `instanceId` once and persist it. A good default is hostname + stable random suffix, not a process id:

```ts
const ensureInstanceId = () => {
  if (config.instanceId) return config.instanceId
  config.instanceId = `pi-${hostname()}-${crypto.randomUUID().slice(0, 8)}`
  saveConfig()
  return config.instanceId
}
```

### Extension skeleton

```ts
import { readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { homedir } from "node:os"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = join(homedir(), ".pi", "agent", "threa-remote.json")
const STATUS_KEY = "threa-remote"

let config: Config | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pending: { invocation: ClaimedInvocation; claimToken: string } | undefined
let activeCtx: ExtensionContext | undefined
let activeRuntimeSessionId: string | undefined

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  if (!config) throw new Error("Threa remote config not loaded")
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Threa API ${response.status}: ${body || response.statusText}`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

async function heartbeat(status: "available" | "busy" | "error", statusText?: string) {
  if (!config) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-runtime/presence`, {
    method: "POST",
    body: JSON.stringify({
      runtimeKind: "pi-local",
      instanceId: ensureInstanceId(),
      displayName: config.defaultDisplayName,
      status,
      acceptingInvocations: status === "available",
      capabilities: {
        supportsActiveScratchpad: true,
        supportsPersistentSessions: true,
        supportsMentionInvocations: false,
      },
      statusText,
    }),
  })
}

async function createRemoteSession(ctx: ExtensionCommandContext, args: string) {
  if (!config) throw new Error("Threa remote config not loaded")
  const runtimeSessionId = ctx.sessionManager.getSessionId() ?? `pi-session-${Date.now()}`
  const displayName = args.trim() || config.defaultDisplayName || ctx.cwd.split("/").pop() || "Pi"

  const body = await request<{ data: RuntimeSessionLink }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        runtimeKind: "pi-local",
        instanceId: ensureInstanceId(),
        runtimeSessionId,
        displayName,
        localCwd: ctx.cwd,
      }),
    }
  )

  activeRuntimeSessionId = runtimeSessionId
  config.linkedSessions ??= {}
  config.linkedSessions[runtimeSessionId] = body.data
  saveConfig()

  ctx.ui.notify(`Threa remote linked: ${body.data.streamUrlPath}`, "info")
  ctx.ui.setStatus(STATUS_KEY, `Threa remote: ${displayName}`)
  await heartbeat("available")
}

async function claimIfIdle(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (!config || pending || !ctx.isIdle()) return

  await heartbeat("available")

  const body = await request<{ data: ClaimedInvocation | null }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-invocations/claim`,
    {
      method: "POST",
      body: JSON.stringify({
        runtimeKind: "pi-local",
        instanceId: ensureInstanceId(),
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 120,
      }),
    }
  )

  if (!body.data) return

  pending = { invocation: body.data, claimToken: body.data.claimToken }
  await heartbeat("busy", `Working on ${body.data.id}`)
  ctx.ui.setStatus(STATUS_KEY, `Threa remote: running ${body.data.id}`)

  pi.sendUserMessage(
    [
      `Remote Threa invocation ${body.data.id}.`,
      `Source message: ${body.data.sourceMessageId}`,
      `Respond normally; the extension will post your final answer back to Threa.`,
      "",
      body.data.promptMarkdown,
    ].join("\n")
  )
}

async function completePending(markdown: string) {
  if (!config || !pending) return
  const { invocation, claimToken } = pending
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken,
      finalMessageMarkdown: markdown || "Done.",
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": ensureInstanceId(),
      },
    }),
  })
  pending = undefined
  await heartbeat("available")
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("remote-control", {
    description: "Create or link a Threa scratchpad to this Pi session",
    handler: async (args, ctx) => {
      config = readConfig()
      if (!config) {
        ctx.ui.notify(`Missing ${CONFIG_PATH}`, "warning")
        return
      }
      await createRemoteSession(ctx, args)
      await claimIfIdle(pi, ctx)
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx
    config = readConfig()
    if (!config) return
    await heartbeat("available")
    timer = setInterval(() => void claimIfIdle(pi, ctx), Math.max(1000, config.pollMs ?? 3000))
  })

  pi.on("agent_end", async (event, ctx) => {
    if (!pending) return
    const text = textFromAgentMessages(event.messages) || "Done."
    try {
      await completePending(text)
      ctx.ui.setStatus(STATUS_KEY, "Threa remote: linked")
    } catch (error) {
      ctx.ui.notify(`Failed to complete Threa invocation: ${String(error)}`, "warning")
      await heartbeat("error", String(error))
    }
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer)
    timer = undefined
    activeCtx = undefined
    await heartbeat("offline").catch(() => undefined)
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
```

The final implementation needs the helper types/functions (`readConfig`, `saveConfig`, `textFromAgentMessages`, `ensureInstanceId`) filled in, but the important behavior is:

- no message polling,
- one claim at a time,
- only claim while idle,
- heartbeat `busy` after claim,
- completion endpoint posts the bot result and marks the invocation complete,
- no `/pi` command prefix in Threa.

### Self-review checklist

- Does the extension ever poll stream messages? It should not.
- Does it claim only while idle and only one invocation at a time?
- Does it persist a stable `instanceId`?
- Does `/remote-control` create/link a dedicated scratchpad rather than expecting all Pi instances to watch one stream?
- Does it use bot-runtime endpoints instead of direct ad-hoc messages for completion?
- Does shutdown heartbeat `offline` best-effort without blocking Pi exit?

### Manual validation

1. Create/update a personal bot with `active-scratchpad` capability.
2. Create a bot API key with runtime + messages scopes.
3. Configure `~/.pi/agent/threa-remote.json`.
4. Start Pi and run `/remote-control`.
5. Verify Threa scratchpad is created and visible to the bot owner.
6. Send `hiya` in that scratchpad.
7. Verify exactly one `bot_invocations` row is created and targeted to this Pi `instanceId`.
8. Verify exactly one Pi instance claims it.
9. Verify Pi response posts back to the scratchpad and invocation becomes `completed`.
10. Start a second Pi instance with the same bot key and verify it does **not** claim the first session's targeted invocation.

---

## Phase 5 — Minimal frontend presence and active-bot UX

### Goal

Make the feature understandable in Threa without building the full multi-runtime UI.

### Suggested files

| File                                                             | Change                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/types/src/domain.ts`                                   | Wire active actor/presence types if needed in bootstrap                                       |
| `apps/backend/src/features/workspaces/handlers.ts`               | Include active actor bindings and runtime presence in bootstrap, or expose a focused endpoint |
| `apps/backend/src/features/streams/handlers.ts`                  | Include active actor for stream bootstrap if not in workspace bootstrap                       |
| `apps/frontend/src/api/*`                                        | API client for active actor/presence endpoint if not bootstrapped                             |
| `apps/frontend/src/components/stream-settings/companion-tab.tsx` | Show active bot actor where appropriate, or split to an `Actors` section later                |
| `apps/frontend/src/components/timeline/stream-content.tsx`       | Small status strip for active bot scratchpads                                                 |
| `apps/frontend/src/components/quick-switcher/commands.ts`        | Optional "Open latest Pi remote" command if labels/session links exist                        |

### Minimal UI

For a scratchpad with active bot `Pi Remote`:

```text
Pi Remote · available · linked to Kris's MacBook Pi
```

If stale/offline:

```text
Pi Remote · offline · run /remote-control in Pi to reconnect
```

Avoid noisy chat messages for routine status. Use chat messages only for failed invocations that need the user's attention.

### Self-review checklist

- Does the status strip avoid layout shift?
- Does it distinguish "bot exists" from "runtime online"?
- Is offline state clear enough that a missing response is not mysterious?
- Are user-owned personal bots hidden from other users?

---

## Phase 6 — Mentionable bot invocations

### Goal

Use the same invocation table for explicit `@bot` one-shot invocations outside active bot scratchpads.

This can ship after Pi remote active scratchpads. It exercises the `mentionable` capability and is useful for stateless helpers.

### Suggested files

| File                                                                  | Change                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/backend/src/features/bot-runtimes/invocation-outbox-handler.ts` | Add mentionable bot resolution                                  |
| `apps/backend/src/features/public-api/bot-repository.ts`              | Add owner-aware slug lookup helper if needed                    |
| `apps/backend/src/features/streams/service.ts`                        | Create/use thread for top-level channel mention response target |
| `apps/backend/src/features/bot-runtimes/*.test.ts`                    | Mention tests                                                   |

### Mention resolution rules

- Resolve slugs against personas and mentionable bots.
- A personal bot is visible only to its owner.
- A shared bot is visible according to workspace policy and stream access.
- Top-level channel mention should create/use a thread for `responseStreamId`.
- Scratchpad, DM, and existing thread mention should respond in current stream.
- If the message also has an active actor, mention suppression applies.

### Response target helper

```ts
async function resolveResponseStreamForMention(params: {
  workspaceId: string
  sourceStream: Stream
  sourceMessageId: string
  authorUserId: string
}): Promise<string> {
  if (params.sourceStream.type === StreamTypes.CHANNEL) {
    const thread = await streamService.createThread({
      workspaceId: params.workspaceId,
      parentStreamId: params.sourceStream.id,
      parentMessageId: params.sourceMessageId,
      createdBy: params.authorUserId,
    })
    return thread.id
  }
  return params.sourceStream.id
}
```

Use this carefully in the outbox handler: if `StreamService.createThread()` owns its own transaction, call it outside the invocation insert transaction or refactor a repository-level helper that can run inside a caller-owned transaction.

---

## Phase 7 — Threa-first pairing code flow

### Goal

Allow a user to create/select a Pi bot scratchpad in Threa first, then link an already-open Pi session with an authorization code.

This is optional for V1 but useful for Claude Code channel parity.

### Suggested files

| File                                                                       | Change                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `apps/backend/src/db/migrations/<timestamp>_bot_runtime_pairing_codes.sql` | Pairing code table                                  |
| `apps/backend/src/features/bot-runtimes/service.ts`                        | Create/consume code                                 |
| `apps/backend/src/features/commands/link-pi-remote-command.ts`             | `/link-pi-remote <code>` server command             |
| `apps/backend/src/server.ts`                                               | Register the command                                |
| `apps/frontend/src/components/editor/triggers/*`                           | Optional conditional slash-command visibility later |
| `docs/examples/pi-remote/threa-remote-v2.ts`                               | Add `/remote-control --pair`                        |

### Pairing table sketch

```sql
CREATE TABLE bot_runtime_pairing_codes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_user_id TEXT,
  consumed_stream_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, bot_id, code_hash)
);
```

### Flow

1. Pi `/remote-control --pair` calls `POST /bot-runtime/pairing-codes` with bot key.
2. Server stores a hashed short code with `instanceId + runtimeSessionId`, expires in 10 minutes.
3. Pi displays: `Run /link-pi-remote 8F4K-2JQ9 in the Threa scratchpad you want to link.`
4. User runs `/link-pi-remote <code>` in a scratchpad.
5. Command verifies:
   - stream is a scratchpad or scratchpad-rooted thread,
   - current user owns the personal bot tied to the code,
   - scratchpad active actor is that bot, or no active actor exists and command sets it,
   - code is unexpired and unconsumed.
6. Command creates `bot_runtime_session_links` and grants bot access.

### Conditional slash command note

Threa's current command registry returns global commands in bootstrap. Do backend validation first and add conditional frontend surfacing later. A future command shape could include:

```ts
type CommandInfo = {
  name: string
  description: string
  kind: "server" | "client-action"
  availability?: {
    streamTypes?: StreamType[]
    activeActorCapabilities?: BotInvocationCapability[]
    activeActorRuntimeKinds?: BotRuntimeKind[]
  }
}
```

Do not block pairing on this UI improvement.

---

## Phase 8 — Stream labels for remote sessions and scratchpad organization

### Goal

Add a general labeling system that makes Pi remote scratchpads easy to find without baking Pi-specific fields into streams.

This should be a generic product primitive, not a bot-runtime-only feature.

### Minimal label model

```sql
CREATE TABLE stream_labels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT, -- null = workspace label, non-null = personal label
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, owner_user_id, slug)
);

CREATE TABLE stream_label_assignments (
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, stream_id, label_id)
);

CREATE INDEX idx_stream_label_assignments_label
  ON stream_label_assignments (workspace_id, label_id);
```

For Pi remote, `createOrLinkPiRemoteSession` can create/use a personal label for the bot owner:

```text
slug: pi-remote
name: Pi remote
color: muted violet/blue
```

Then assign it to the created scratchpad. Quick switcher/search can later support `label:pi-remote`.

### Why this is a later phase

A display name like `Pi Remote: threa` is enough for the protocol V1. Labels are valuable but should not delay the invocation/claim correctness path.

---

## Suggested minimal PR order

1. **PR 1: Runtime protocol tables and repositories**
   - constants, migration, repositories, claim tests.
2. **PR 2: Runtime public API**
   - presence/session/claim/complete endpoints, OpenAPI, bot thread access inheritance.
3. **PR 3: Active bot scratchpad invocation producer**
   - active actor lookup, invocation creation, mention suppression for active bots.
4. **PR 4: Pi remote v2 adapter**
   - `/remote-control`, heartbeat, targeted claims, completion.
5. **PR 5: Minimal frontend presence**
   - status strip and offline messaging.
6. **PR 6: Mentionable bot invocations**
   - explicit `@bot` one-shot behavior.
7. **PR 7: Pairing code flow**
   - Threa-first existing-session linking.
8. **PR 8: Stream labels**
   - generic labels; auto-label Pi remote scratchpads.

If schedule is tight, PRs 1–4 are the minimum needed to replace the current global plugin safely.

## Review cadence

Before opening each next PR:

```bash
gh pr view <previous-pr> --json statusCheckRollup,reviewDecision,url
```

Then inspect comments/check failures. Treat every CodeRabbit/Greptile finding as one of:

- **Accept**: fix in the current/top PR if it affects shared code,
- **Acknowledge**: real but intentionally deferred to a later stacked PR,
- **Dispute**: incorrect, with a specific technical reason.

Do not build on a previous PR with unresolved correctness/security feedback in the protocol, claim, or access-control layers.

## Non-goals for the minimal Pi adapter

- Starting/spawning a new local Pi process from Threa.
- Worktree management in Threa.
- Multi-agent orchestration.
- Rich runtime artifacts/cards.
- Streaming token-by-token remote output.
- Permission relay for tool approvals.
- Replacing OpenClaw for hosted/sandboxed coding sessions.
