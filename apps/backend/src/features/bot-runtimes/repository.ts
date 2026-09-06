import {
  BOT_INVOCATION_CAPABILITIES,
  BOT_INVOCATION_STATUSES,
  BOT_INVOCATION_TRIGGERS,
  BOT_RUNTIME_KINDS,
  BOT_RUNTIME_SESSION_LINK_STATUSES,
  BOT_RUNTIME_STATUSES,
  type BotInvocationCapability,
  type BotInvocationStatus,
  type BotInvocationTrigger,
  type BotInputUpdateMode,
  type BotInvocationCancellationReason,
  type BotRuntimeKind,
  type BotRuntimeManifest,
  type BotRuntimeSessionLinkStatus,
  type BotRuntimeStatus,
} from "@threa/types"
import type { Pool, QueryConfig } from "pg"
import { composeSql, sql, withTransaction, type Querier } from "../../db"

export type RuntimeSessionLinkStatus = BotRuntimeSessionLinkStatus

/**
 * How recently a bot runtime instance must have been seen for its BIK to be
 * wrapped into a stream's SSK roll. Matches the enclave staleness window so the
 * two actor kinds share one notion of "live enough to receive key material".
 */
export const BOT_RUNTIME_BIK_STALENESS_MS = 2 * 60 * 1000

/**
 * How many times the claim loop will re-dispatch a single invocation before it
 * is parked (dead-lettered). Each claim increments `attempts`; a claim only
 * comes back up for grabs when its TTL expires without a `/complete` or
 * `/fail`, i.e. the runtime took the work and went silent. Bounding this
 * matches the retry discipline every first-party queue job already has — a
 * wedged runtime can't pin one invocation in an infinite re-claim loop.
 */
export const BOT_CLAIM_MAX_ATTEMPTS = 5

export interface StreamActiveActor {
  id: string
  workspaceId: string
  rootStreamId: string
  actorType: "persona" | "bot"
  actorId: string
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

export interface BotRuntimeInstance {
  id: string
  workspaceId: string
  botId: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  displayName: string | null
  status: BotRuntimeStatus
  acceptingInvocations: boolean
  capabilities: Record<string, unknown>
  // Declared-output manifest from bot:hello; null = legacy default profile,
  // which the reject-undeclared boundary leaves unenforced (Phase 2.3b).
  manifest: BotRuntimeManifest | null
  statusText: string | null
  // BIK — the runtime's per-session X25519 public key (base64) and the short id
  // used as `recipient_key_id` when wrapping a stream's SSK to this bot. Null
  // until a session registers one; non-E2E runtimes never do.
  publicKey: string | null
  publicKeyId: string | null
  lastSeenAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface BotRuntimeSessionLink {
  id: string
  workspaceId: string
  botId: string
  runtimeKind: BotRuntimeKind
  instanceId: string
  runtimeSessionId: string
  rootStreamId: string
  activeStreamId: string
  status: RuntimeSessionLinkStatus
  linkedBy: string
  metadata: Record<string, unknown>
  lastSeenAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface BotInvocationCancellation {
  invocationId: string
  sourceRevision: number
  reason: BotInvocationCancellationReason
  targetInstanceId: string
  targetRuntimeSessionId: string | null
}

export function resolveControlTarget(
  invocation: Pick<
    BotInvocation,
    "claimedByInstanceId" | "targetInstanceId" | "claimedRuntimeSessionId" | "targetRuntimeSessionId"
  >
): { targetInstanceId: string | null; targetRuntimeSessionId: string | null } {
  return {
    targetInstanceId: invocation.claimedByInstanceId ?? invocation.targetInstanceId,
    targetRuntimeSessionId:
      invocation.claimedRuntimeSessionId ??
      (invocation.claimedByInstanceId == null ? invocation.targetRuntimeSessionId : null),
  }
}

export interface BotInvocation {
  id: string
  workspaceId: string
  rootStreamId: string
  activeStreamId: string
  sourceMessageId: string
  responseStreamId: string
  actorType: "bot"
  actorId: string
  trigger: BotInvocationTrigger
  requiredCapability: BotInvocationCapability
  promptMarkdown: string
  sourceMessageRevision: number
  claimedSourceMessageRevision: number | null
  claimedInputUpdateMode: BotInputUpdateMode | null
  cancellationReason: BotInvocationCancellationReason | null
  authorUserId: string
  mentionedActorSlugs: string[]
  status: BotInvocationStatus
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  claimedByInstanceId: string | null
  claimedRuntimeSessionId: string | null
  claimedRuntimeSessionClaimToken: string | null
  claimToken: string | null
  claimExpiresAt: Date | null
  attempts: number
  errorMessage: string | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

interface StreamActiveActorRow {
  id: string
  workspace_id: string
  root_stream_id: string
  actor_type: string
  actor_id: string
  created_by: string
  created_at: Date
  updated_at: Date
}

interface BotRuntimeInstanceRow {
  id: string
  workspace_id: string
  bot_id: string
  runtime_kind: string
  instance_id: string
  display_name: string | null
  status: string
  accepting_invocations: boolean
  capabilities: Record<string, unknown>
  manifest: BotRuntimeManifest | null
  status_text: string | null
  public_key: string | null
  public_key_id: string | null
  last_seen_at: Date
  created_at: Date
  updated_at: Date
}

interface BotRuntimeSessionLinkRow {
  id: string
  workspace_id: string
  bot_id: string
  runtime_kind: string
  instance_id: string
  runtime_session_id: string
  root_stream_id: string
  active_stream_id: string
  status: string
  linked_by: string
  metadata: Record<string, unknown>
  last_seen_at: Date | null
  created_at: Date
  updated_at: Date
}

interface BotInvocationRow {
  id: string
  workspace_id: string
  root_stream_id: string
  active_stream_id: string
  source_message_id: string
  response_stream_id: string
  actor_type: string
  actor_id: string
  trigger: string
  required_capability: string
  prompt_markdown: string
  source_message_revision: number
  claimed_source_message_revision: number | null
  claimed_input_update_mode: string | null
  cancellation_reason: string | null
  author_user_id: string
  mentioned_actor_slugs: string[]
  status: string
  target_instance_id: string | null
  target_runtime_session_id: string | null
  claimed_by_instance_id: string | null
  claimed_runtime_session_id: string | null
  claimed_runtime_session_claim_token: string | null
  claim_token: string | null
  claim_expires_at: Date | null
  attempts: number
  error_message: string | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

interface BotInvocationRowWithInsertMarker extends BotInvocationRow {
  was_newly_inserted: boolean
}

interface DesiredInvocationRouteIdentity {
  actorId: string
  trigger: string
  activeStreamId: string
  responseStreamId: string
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
}

interface BotInvocationActorSourceRow {
  workspace_id: string
  source_message_id: string
  actor_type: string
  actor_id: string
}

interface BotInvocationSourceIdentity {
  workspaceId: string
  sourceMessageId: string
}

interface BotInvocationActorSourceIdentity extends BotInvocationSourceIdentity {
  actorType: string
  actorId: string
}

function botInvocationSourceLockKey(identity: BotInvocationSourceIdentity): string {
  return ["bot_invocation_source", identity.workspaceId, identity.sourceMessageId].join("\u001f")
}

export function botInvocationActorSourceLockKey(identity: BotInvocationActorSourceIdentity): string {
  return [
    "bot_invocation_actor_source",
    identity.workspaceId,
    identity.sourceMessageId,
    identity.actorType,
    identity.actorId,
  ].join("\u001f")
}

function isPoolQuerier(db: Querier): db is Pool {
  return "connect" in db && typeof db.connect === "function"
}

async function withTransactionIfPool<T>(db: Querier, operation: (lockedDb: Querier) => Promise<T>): Promise<T> {
  return isPoolQuerier(db) ? withTransaction(db, operation) : operation(db)
}

async function acquireLocks<T>(db: Querier, identities: T[], keyFn: (identity: T) => string): Promise<void> {
  const lockKeys = [...new Set(identities.map(keyFn))].sort()
  for (const lockKey of lockKeys) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey])
  }
}

async function acquireSourceLocks(db: Querier, identities: BotInvocationSourceIdentity[]): Promise<void> {
  await acquireLocks(db, identities, botInvocationSourceLockKey)
}

async function acquireActorLocks(db: Querier, identities: BotInvocationActorSourceIdentity[]): Promise<void> {
  await acquireLocks(db, identities, botInvocationActorSourceLockKey)
}

async function acquireActorSourceLocks(db: Querier, identities: BotInvocationActorSourceIdentity[]): Promise<void> {
  await acquireSourceLocks(db, identities)
  await acquireActorLocks(db, identities)
}

function mapActorSourceIdentity(row: BotInvocationActorSourceRow): BotInvocationActorSourceIdentity {
  return {
    workspaceId: row.workspace_id,
    sourceMessageId: row.source_message_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
  }
}

async function findInvocationActorSource(
  db: Querier,
  params: { workspaceId: string; botId: string; invocationId: string }
): Promise<(BotInvocationActorSourceIdentity & { trigger: string }) | null> {
  const result = await db.query<BotInvocationActorSourceRow & { trigger: string }>(sql`
    SELECT workspace_id, source_message_id, actor_type, actor_id, trigger
    FROM bot_invocations
    WHERE id = ${params.invocationId}
      AND workspace_id = ${params.workspaceId}
      AND actor_type = 'bot'
      AND actor_id = ${params.botId}
  `)
  const row = result.rows[0]
  return row ? { ...mapActorSourceIdentity(row), trigger: row.trigger } : null
}

/**
 * The two paths that must hold the message row read it through a join with `FOR SHARE OF m` rather
 * than an `EXISTS`, so the lock survives — which is why those call sites keep their own statement shape.
 */
function canonicalSourceGateSql(alias: string, revisionSql: QueryConfig): QueryConfig {
  const invocation: QueryConfig = { text: alias, values: [] }
  return composeSql`s.workspace_id = ${invocation}.workspace_id
              AND m.stream_id = ${invocation}.active_stream_id
              AND m.deleted_at IS NULL
              AND m.revision = ${revisionSql}`
}

async function lockCanonicalInvocationSource(
  db: Querier,
  params: { workspaceId: string; botId: string; invocationId: string; sourceRevision?: number }
): Promise<boolean> {
  const result = await db.query<{ id: string }>(composeSql`
    SELECT m.id
    FROM bot_invocations i
    JOIN messages m ON m.id = i.source_message_id
    JOIN streams s ON s.id = m.stream_id
    WHERE i.id = ${params.invocationId}
      AND i.workspace_id = ${params.workspaceId}
      AND i.actor_type = 'bot'
      AND i.actor_id = ${params.botId}
      AND ${canonicalSourceGateSql("i", sql`COALESCE(${params.sourceRevision ?? null}, i.claimed_source_message_revision)`)}
      AND (
        ${params.sourceRevision ?? null}::int IS NULL
        OR i.claimed_source_message_revision = ${params.sourceRevision ?? null}
        OR (
          i.claimed_input_update_mode = 'live'
          AND ${params.sourceRevision ?? null} > i.claimed_source_message_revision
        )
      )
    FOR SHARE OF m
  `)
  return result.rows.length > 0
}

const knownRuntimeKinds = new Set<string>(BOT_RUNTIME_KINDS)
const knownRuntimeStatuses = new Set<string>(BOT_RUNTIME_STATUSES)
const knownInvocationStatuses = new Set<string>(BOT_INVOCATION_STATUSES)
const knownInvocationTriggers = new Set<string>(BOT_INVOCATION_TRIGGERS)
const knownInvocationCapabilities = new Set<string>(BOT_INVOCATION_CAPABILITIES)
const knownLinkStatuses = new Set<string>(BOT_RUNTIME_SESSION_LINK_STATUSES)

function assertKnown(value: string, known: Set<string>, label: string): void {
  if (!known.has(value)) throw new Error(`Unknown ${label}: ${value}`)
}

function mapActiveActor(row: StreamActiveActorRow): StreamActiveActor {
  if (row.actor_type !== "persona" && row.actor_type !== "bot")
    throw new Error(`Unknown active actor type: ${row.actor_type}`)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    rootStreamId: row.root_stream_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapRuntimeInstance(row: BotRuntimeInstanceRow): BotRuntimeInstance {
  assertKnown(row.runtime_kind, knownRuntimeKinds, "runtime kind")
  assertKnown(row.status, knownRuntimeStatuses, "runtime status")
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    botId: row.bot_id,
    runtimeKind: row.runtime_kind as BotRuntimeKind,
    instanceId: row.instance_id,
    displayName: row.display_name,
    status: row.status as BotRuntimeStatus,
    acceptingInvocations: row.accepting_invocations,
    capabilities: row.capabilities,
    manifest: row.manifest,
    statusText: row.status_text,
    publicKey: row.public_key,
    publicKeyId: row.public_key_id,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSessionLink(row: BotRuntimeSessionLinkRow): BotRuntimeSessionLink {
  assertKnown(row.runtime_kind, knownRuntimeKinds, "runtime kind")
  assertKnown(row.status, knownLinkStatuses, "runtime session link status")
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    botId: row.bot_id,
    runtimeKind: row.runtime_kind as BotRuntimeKind,
    instanceId: row.instance_id,
    runtimeSessionId: row.runtime_session_id,
    rootStreamId: row.root_stream_id,
    activeStreamId: row.active_stream_id,
    status: row.status as RuntimeSessionLinkStatus,
    linkedBy: row.linked_by,
    metadata: row.metadata,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapInvocation(row: BotInvocationRow): BotInvocation {
  if (row.actor_type !== "bot") throw new Error(`Unknown invocation actor type: ${row.actor_type}`)
  assertKnown(row.trigger, knownInvocationTriggers, "invocation trigger")
  assertKnown(row.required_capability, knownInvocationCapabilities, "invocation capability")
  assertKnown(row.status, knownInvocationStatuses, "invocation status")
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    rootStreamId: row.root_stream_id,
    activeStreamId: row.active_stream_id,
    sourceMessageId: row.source_message_id,
    responseStreamId: row.response_stream_id,
    actorType: "bot",
    actorId: row.actor_id,
    trigger: row.trigger as BotInvocationTrigger,
    requiredCapability: row.required_capability as BotInvocationCapability,
    promptMarkdown: row.prompt_markdown,
    sourceMessageRevision: row.source_message_revision,
    claimedSourceMessageRevision: row.claimed_source_message_revision,
    claimedInputUpdateMode: row.claimed_input_update_mode as BotInputUpdateMode | null,
    cancellationReason: row.cancellation_reason as BotInvocationCancellationReason | null,
    authorUserId: row.author_user_id,
    mentionedActorSlugs: row.mentioned_actor_slugs,
    status: row.status as BotInvocationStatus,
    targetInstanceId: row.target_instance_id,
    targetRuntimeSessionId: row.target_runtime_session_id,
    claimedByInstanceId: row.claimed_by_instance_id,
    claimedRuntimeSessionId: row.claimed_runtime_session_id,
    claimedRuntimeSessionClaimToken: row.claimed_runtime_session_claim_token,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    attempts: row.attempts,
    errorMessage: row.error_message,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export const StreamActiveActorRepository = {
  // Do not call this directly from outside this feature. Mutate active actors
  // through `BotRuntimeService.setActiveActorInTransaction` so the
  // `bot:active_actor_changed` outbox event is emitted in the same tx — bots
  // (especially Pi remote) rely on that push to learn they've been displaced.
  async upsert(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      rootStreamId: string
      actorType: "persona" | "bot"
      actorId: string
      createdBy: string
    }
  ): Promise<StreamActiveActor> {
    const result =
      await db.query<StreamActiveActorRow>(sql`INSERT INTO stream_active_actors (id, workspace_id, root_stream_id, actor_type, actor_id, created_by)
      VALUES (${params.id}, ${params.workspaceId}, ${params.rootStreamId}, ${params.actorType}, ${params.actorId}, ${params.createdBy})
      ON CONFLICT (workspace_id, root_stream_id) DO UPDATE SET actor_type = EXCLUDED.actor_type, actor_id = EXCLUDED.actor_id, updated_at = NOW()
      RETURNING *`)
    return mapActiveActor(result.rows[0]!)
  },

  async findByRootStream(db: Querier, workspaceId: string, rootStreamId: string): Promise<StreamActiveActor | null> {
    const result = await db.query<StreamActiveActorRow>(
      sql`SELECT * FROM stream_active_actors WHERE workspace_id = ${workspaceId} AND root_stream_id = ${rootStreamId}`
    )
    return result.rows[0] ? mapActiveActor(result.rows[0]) : null
  },

  // Bootstrap helper for the `/bot` WS namespace: every stream where this bot
  // is the active actor. The runtime needs this on reconnect so it knows which
  // streams it is on the hook for without re-running its scratchpad scan.
  async findActiveForBot(db: Querier, params: { workspaceId: string; botId: string }): Promise<StreamActiveActor[]> {
    const result = await db.query<StreamActiveActorRow>(
      sql`SELECT * FROM stream_active_actors WHERE workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId}`
    )
    return result.rows.map(mapActiveActor)
  },
}

export const BotRuntimeInstanceRepository = {
  async findLatestForBot(db: Querier, workspaceId: string, botId: string): Promise<BotRuntimeInstance | null> {
    const result = await db.query<BotRuntimeInstanceRow>(
      sql`SELECT * FROM bot_runtime_instances WHERE workspace_id = ${workspaceId} AND bot_id = ${botId} ORDER BY last_seen_at DESC LIMIT 1`
    )
    return result.rows[0] ? mapRuntimeInstance(result.rows[0]) : null
  },

  async findByInstance(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string }
  ): Promise<BotRuntimeInstance | null> {
    const result = await db.query<BotRuntimeInstanceRow>(
      sql`SELECT * FROM bot_runtime_instances WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND instance_id = ${params.instanceId} LIMIT 1`
    )
    return result.rows[0] ? mapRuntimeInstance(result.rows[0]) : null
  },

  /**
   * Live instances of one bot that have registered a BIK, for SSK wrapping.
   * "Live" mirrors the enclave model — recently seen and not offline — so a
   * roll wraps to every instance that could currently claim an invocation,
   * letting whichever one the dispatcher picks decrypt. Instances without a
   * `public_key` (non-E2E runtimes) are excluded.
   */
  async findLiveWithKeyForBot(
    db: Querier,
    params: { workspaceId: string; botId: string; stalenessMs: number }
  ): Promise<BotRuntimeInstance[]> {
    const result = await db.query<BotRuntimeInstanceRow>(sql`
      SELECT * FROM bot_runtime_instances
      WHERE workspace_id = ${params.workspaceId}
        AND bot_id = ${params.botId}
        AND public_key IS NOT NULL
        AND public_key_id IS NOT NULL
        AND status <> 'offline'
        AND last_seen_at > NOW() - (${params.stalenessMs} || ' milliseconds')::interval
      ORDER BY last_seen_at DESC
    `)
    return result.rows.map(mapRuntimeInstance)
  },

  async findLatestForBots(
    db: Querier,
    workspaceId: string,
    botIds: string[]
  ): Promise<Map<string, BotRuntimeInstance>> {
    if (botIds.length === 0) return new Map()
    const result = await db.query<BotRuntimeInstanceRow>(
      sql`SELECT DISTINCT ON (bot_id) * FROM bot_runtime_instances WHERE workspace_id = ${workspaceId} AND bot_id = ANY(${botIds}) ORDER BY bot_id, last_seen_at DESC`
    )
    return new Map(result.rows.map((row) => [row.bot_id, mapRuntimeInstance(row)]))
  },

  async upsertPresence(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      displayName?: string | null
      status: BotRuntimeStatus
      acceptingInvocations: boolean
      capabilities: Record<string, unknown>
      manifest?: BotRuntimeManifest | null
      statusText?: string | null
      publicKey?: string | null
      publicKeyId?: string | null
      mergeCapabilities?: boolean
      retainBik?: boolean
      retainManifest?: boolean
    }
  ): Promise<BotRuntimeInstance> {
    // BIK is per-session key material, so a presence write OVERWRITES it by
    // default — a session that registers no key clears any stale one, so
    // `findLiveWithKeyForBot` never hands out wraps for a key the runtime has
    // rotated away. Only the server-internal writes that legitimately don't
    // carry the key (the invocation touch and the session-link path) pass
    // `retainBik` to keep the live session's key instead of nulling it.
    const publicKey = params.publicKey ?? null
    const publicKeyId = params.publicKeyId ?? null
    const capabilitiesSet = params.mergeCapabilities
      ? "capabilities = bot_runtime_instances.capabilities || EXCLUDED.capabilities"
      : "capabilities = EXCLUDED.capabilities"
    const bikSet = params.retainBik
      ? "public_key = COALESCE(EXCLUDED.public_key, bot_runtime_instances.public_key), public_key_id = COALESCE(EXCLUDED.public_key_id, bot_runtime_instances.public_key_id)"
      : "public_key = EXCLUDED.public_key, public_key_id = EXCLUDED.public_key_id"
    const manifestSet = params.retainManifest
      ? "manifest = COALESCE(EXCLUDED.manifest, bot_runtime_instances.manifest)"
      : "manifest = EXCLUDED.manifest"
    const result =
      await db.query<BotRuntimeInstanceRow>(sql`INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, runtime_kind, instance_id, display_name, status, accepting_invocations, capabilities, manifest, status_text, public_key, public_key_id)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.runtimeKind}, ${params.instanceId}, ${params.displayName ?? null}, ${params.status}, ${params.acceptingInvocations}, ${params.capabilities}, ${params.manifest ?? null}, ${params.statusText ?? null}, ${publicKey}, ${publicKeyId})
      ON CONFLICT (workspace_id, bot_id, instance_id) DO UPDATE SET runtime_kind = EXCLUDED.runtime_kind, display_name = EXCLUDED.display_name, status = EXCLUDED.status, accepting_invocations = EXCLUDED.accepting_invocations, ${sql.raw(capabilitiesSet)}, ${sql.raw(manifestSet)}, status_text = EXCLUDED.status_text, ${sql.raw(bikSet)}, last_seen_at = NOW(), updated_at = NOW()
      RETURNING *`)
    return mapRuntimeInstance(result.rows[0]!)
  },

  /**
   * Mark an instance offline after its socket grace window expires with no
   * reconnect and no newer heartbeat. Does NOT delete the row —
   * `BotInvocationRepository.claimOne` has an `EXISTS … FROM
   * bot_runtime_instances` check for `target_instance_id`-pinned invocations
   * and would refuse to hand them back when the instance reconnects later if
   * we deleted the row.
   */
  async markOffline(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string; disconnectedAt: Date }
  ): Promise<void> {
    await db.query(
      sql`UPDATE bot_runtime_instances
        SET status = 'offline', accepting_invocations = FALSE, last_seen_at = NOW(), updated_at = NOW()
        WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND instance_id = ${params.instanceId} AND last_seen_at <= ${params.disconnectedAt}`
    )
  },
}

export const BotRuntimeSessionLinkRepository = {
  async upsert(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
      rootStreamId: string
      activeStreamId: string
      linkedBy: string
      metadata?: Record<string, unknown>
    }
  ): Promise<BotRuntimeSessionLink> {
    const result =
      await db.query<BotRuntimeSessionLinkRow>(sql`INSERT INTO bot_runtime_session_links (id, workspace_id, bot_id, runtime_kind, instance_id, runtime_session_id, root_stream_id, active_stream_id, linked_by, metadata, last_seen_at)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.runtimeKind}, ${params.instanceId}, ${params.runtimeSessionId}, ${params.rootStreamId}, ${params.activeStreamId}, ${params.linkedBy}, ${params.metadata ?? {}}, NOW())
      ON CONFLICT (workspace_id, bot_id, root_stream_id, active_stream_id) DO UPDATE SET runtime_kind = EXCLUDED.runtime_kind, instance_id = EXCLUDED.instance_id, runtime_session_id = EXCLUDED.runtime_session_id, linked_by = EXCLUDED.linked_by, status = 'active', metadata = EXCLUDED.metadata, last_seen_at = NOW(), updated_at = NOW()
      RETURNING *`)
    return mapSessionLink(result.rows[0]!)
  },

  /**
   * Same insert as `upsert`, but an ACTIVE link on (workspace, bot, root,
   * active) is never replaced: the conflicting row is left alone and null
   * comes back. The unique index serializes concurrent inserts, so two
   * callers racing for the same stream cannot both win (INV-20). Ended or
   * archived rows are revived like `upsert` does.
   */
  async upsertUnlessActive(
    db: Querier,
    params: {
      id: string
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
      rootStreamId: string
      activeStreamId: string
      linkedBy: string
      metadata?: Record<string, unknown>
    }
  ): Promise<BotRuntimeSessionLink | null> {
    const result =
      await db.query<BotRuntimeSessionLinkRow>(sql`INSERT INTO bot_runtime_session_links (id, workspace_id, bot_id, runtime_kind, instance_id, runtime_session_id, root_stream_id, active_stream_id, linked_by, metadata, last_seen_at)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.runtimeKind}, ${params.instanceId}, ${params.runtimeSessionId}, ${params.rootStreamId}, ${params.activeStreamId}, ${params.linkedBy}, ${params.metadata ?? {}}, NOW())
      ON CONFLICT (workspace_id, bot_id, root_stream_id, active_stream_id) DO UPDATE SET runtime_kind = EXCLUDED.runtime_kind, instance_id = EXCLUDED.instance_id, runtime_session_id = EXCLUDED.runtime_session_id, linked_by = EXCLUDED.linked_by, status = 'active', metadata = EXCLUDED.metadata, last_seen_at = NOW(), updated_at = NOW()
      WHERE bot_runtime_session_links.status <> 'active'
      RETURNING *`)
    const row = result.rows[0]
    return row ? mapSessionLink(row) : null
  },

  /**
   * End every active link rooted at a stream (its scratchpad was archived) and
   * return the ended rows so the caller can notify each runtime. Writes the
   * recoverable 'archived' status — not terminal 'ended' — so a later
   * stream:unarchived can revive exactly these links. One set-based
   * UPDATE … RETURNING so concurrent archive/consumer retries can't double-end
   * or race a link back to life (INV-20, INV-56).
   */
  async archiveActiveByRootStream(
    db: Querier,
    params: { workspaceId: string; rootStreamId: string }
  ): Promise<BotRuntimeSessionLink[]> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`UPDATE bot_runtime_session_links SET status = 'archived', updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND root_stream_id = ${params.rootStreamId} AND status = 'active'
      RETURNING *`
    )
    return result.rows.map(mapSessionLink)
  },

  /**
   * Revive every archive-ended link rooted at a stream (its scratchpad was
   * unarchived). Scoped to status = 'archived' so links a runtime ended by
   * shutting down normally stay dead (INV-20, INV-56).
   */
  async reactivateArchivedByRootStream(
    db: Querier,
    params: { workspaceId: string; rootStreamId: string }
  ): Promise<BotRuntimeSessionLink[]> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`UPDATE bot_runtime_session_links SET status = 'active', last_seen_at = NOW(), updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId} AND root_stream_id = ${params.rootStreamId} AND status = 'archived'
      RETURNING *`
    )
    return result.rows.map(mapSessionLink)
  },

  /**
   * Revive the newest archive-ended link for one runtime session identity —
   * the session-create reattach path. The stream guard keeps a still-archived
   * scratchpad's link dead (the caller 409s instead of minting a duplicate
   * scratchpad), and the locked CTE makes concurrent reattach/unarchive
   * consumers converge on one winner (INV-20).
   *
   * The stream row is locked FOR SHARE in the same candidate select — an
   * unlocked read (EXISTS) would be TOCTOU against a concurrent re-archive:
   * the re-archive's stream:archived consumer could skip this link (its
   * 'active' write still uncommitted here) and leave an active link on an
   * archived stream that nothing ever corrects. With the share lock, a
   * concurrent archive of the stream waits for this commit, and its consumer
   * then archives the freshly revived link. Call inside a transaction.
   */
  async reactivateArchivedByRuntimeSession(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
    }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(sql`WITH candidate AS (
        SELECT l.id FROM bot_runtime_session_links l
        JOIN streams s
          ON s.workspace_id = l.workspace_id AND s.id = l.root_stream_id AND s.archived_at IS NULL
        WHERE l.workspace_id = ${params.workspaceId}
          AND l.bot_id = ${params.botId}
          AND l.runtime_kind = ${params.runtimeKind}
          AND l.instance_id = ${params.instanceId}
          AND l.runtime_session_id = ${params.runtimeSessionId}
          AND l.status = 'archived'
        ORDER BY l.updated_at DESC
        LIMIT 1
        FOR UPDATE OF l SKIP LOCKED
        FOR SHARE OF s
      )
      UPDATE bot_runtime_session_links l
      SET status = 'active', last_seen_at = NOW(), updated_at = NOW()
      FROM candidate
      WHERE l.id = candidate.id
      RETURNING l.*`)
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  /**
   * Retire the newest archive-ended link for one runtime session identity —
   * the session-create `ifArchived: "replace"` path. The identity's unique key
   * (workspace, bot, kind, instance, session) is unconditional, so an archived
   * link permanently blocks a fresh create until its runtime_session_id is
   * renamed out of the way; the terminal 'ended' status keeps a later
   * stream:unarchived from reviving a link no connector can reach anymore.
   *
   * The stream guard is the inverse of reactivate's: only retire while the
   * scratchpad IS still archived, with the stream row share-locked in the same
   * candidate select so a concurrent unarchive serializes against this commit
   * (its consumer then finds no 'archived' link — the retire won) instead of
   * racing the same row. Call inside a transaction.
   */
  async retireArchivedByRuntimeSession(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
    }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(sql`WITH candidate AS (
        SELECT l.id FROM bot_runtime_session_links l
        JOIN streams s
          ON s.workspace_id = l.workspace_id AND s.id = l.root_stream_id AND s.archived_at IS NOT NULL
        WHERE l.workspace_id = ${params.workspaceId}
          AND l.bot_id = ${params.botId}
          AND l.runtime_kind = ${params.runtimeKind}
          AND l.instance_id = ${params.instanceId}
          AND l.runtime_session_id = ${params.runtimeSessionId}
          AND l.status = 'archived'
        ORDER BY l.updated_at DESC
        LIMIT 1
        FOR UPDATE OF l SKIP LOCKED
        FOR SHARE OF s
      )
      UPDATE bot_runtime_session_links l
      SET status = 'ended', runtime_session_id = l.runtime_session_id || ':retired:' || l.id, updated_at = NOW()
      FROM candidate
      WHERE l.id = candidate.id
      RETURNING l.*`)
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  /**
   * Frees the identity by appending `:retired:<id>` to `runtime_session_id` —
   * the (kind, instance, session) unique key is unconditional, so a plain
   * 'ended' row would block a future session from reusing it.
   */
  async endActiveByRuntimeSession(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string; runtimeSessionId: string }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(sql`
      UPDATE bot_runtime_session_links
      SET status = 'ended', runtime_session_id = runtime_session_id || ':retired:' || id, updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND bot_id = ${params.botId}
        AND instance_id = ${params.instanceId}
        AND runtime_session_id = ${params.runtimeSessionId}
        AND status = 'active'
      RETURNING *
    `)
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  /** Newest archive-ended link for one runtime session identity (regardless of the stream's archive state). */
  async findArchivedByRuntimeSession(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
    }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links
        WHERE workspace_id = ${params.workspaceId}
          AND bot_id = ${params.botId}
          AND runtime_kind = ${params.runtimeKind}
          AND instance_id = ${params.instanceId}
          AND runtime_session_id = ${params.runtimeSessionId}
          AND status = 'archived'
        ORDER BY updated_at DESC
        LIMIT 1`
    )
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  /** Share-lock the active link for the runtime identity that won a claim (INV-20). */
  async findActiveByRuntimeSessionForShare(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string; runtimeSessionId: string }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links
        WHERE workspace_id = ${params.workspaceId}
          AND bot_id = ${params.botId}
          AND instance_id = ${params.instanceId}
          AND runtime_session_id = ${params.runtimeSessionId}
          AND status = 'active'
        ORDER BY updated_at DESC
        LIMIT 1
        FOR SHARE`
    )
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  async findActiveByStream(
    db: Querier,
    params: { workspaceId: string; botId: string; rootStreamId: string; activeStreamId: string }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND root_stream_id = ${params.rootStreamId} AND active_stream_id = ${params.activeStreamId} AND status = 'active'`
    )
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  /**
   * Route resolution's read of the link it is about to target (INV-20). The share
   * lock serializes against `endActiveByRuntimeSession`: without it a reconcile
   * that read the link a moment before `/done` ended it goes on to insert an
   * invocation targeted at a session that no longer exists, and since claiming
   * requires `target_runtime_session_id IS NULL OR = <claimer>`, no other session
   * can ever pick it up — the message silently gets no reply.
   */
  async findActiveByStreamForShare(
    db: Querier,
    params: { workspaceId: string; botId: string; rootStreamId: string; activeStreamId: string }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND root_stream_id = ${params.rootStreamId} AND active_stream_id = ${params.activeStreamId} AND status = 'active' FOR SHARE`
    )
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  // A runtime client is identified by (instanceId, runtimeSessionId). Session-create
  // callers pass `runtimeKind` so reuse matches the link of the kind being created —
  // the unique key includes runtime_kind, so two kinds can hold the same instance/
  // session pair. Rename callers omit it to match that runtime identity across kinds;
  // `ORDER BY updated_at DESC LIMIT 1` keeps the kindless case deterministic.
  async findActiveByRuntimeSession(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      instanceId: string
      runtimeSessionId: string
      runtimeKind?: BotRuntimeKind
    }
  ): Promise<BotRuntimeSessionLink | null> {
    const kind = params.runtimeKind ?? null
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links
        WHERE workspace_id = ${params.workspaceId}
          AND bot_id = ${params.botId}
          AND instance_id = ${params.instanceId}
          AND runtime_session_id = ${params.runtimeSessionId}
          AND status = 'active'
          AND (${kind}::text IS NULL OR runtime_kind = ${kind})
        ORDER BY updated_at DESC
        LIMIT 1`
    )
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  async rebindInstance(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      linkId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
      newInstanceId: string
    }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(sql`UPDATE bot_runtime_session_links
      SET instance_id = ${params.newInstanceId}, last_seen_at = NOW(), updated_at = NOW()
      WHERE id = ${params.linkId}
        AND workspace_id = ${params.workspaceId}
        AND bot_id = ${params.botId}
        AND runtime_kind = ${params.runtimeKind}
        AND instance_id = ${params.instanceId}
        AND runtime_session_id = ${params.runtimeSessionId}
        AND status = 'active'
      RETURNING *`)
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  async findActiveByStreams(
    db: Querier,
    params: { workspaceId: string; botId: string; activeStreamIds: string[] }
  ): Promise<Map<string, BotRuntimeSessionLink>> {
    if (params.activeStreamIds.length === 0) return new Map()
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT DISTINCT ON (active_stream_id) * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND active_stream_id = ANY(${params.activeStreamIds}) AND status = 'active' ORDER BY active_stream_id, updated_at DESC`
    )
    return new Map(result.rows.map((row) => [row.active_stream_id, mapSessionLink(row)]))
  },

  async findActiveByBotsAndStream(
    db: Querier,
    params: { workspaceId: string; botIds: string[]; activeStreamId: string }
  ): Promise<Map<string, BotRuntimeSessionLink>> {
    if (params.botIds.length === 0) return new Map()
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT DISTINCT ON (bot_id) * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ANY(${params.botIds}) AND active_stream_id = ${params.activeStreamId} AND status = 'active' ORDER BY bot_id, updated_at DESC`
    )
    return new Map(result.rows.map((row) => [row.bot_id, mapSessionLink(row)]))
  },

  // Bootstrap helper for the `/bot` WS namespace: every active session link
  // for this bot/instance, so the runtime can rebuild its (rootStream ->
  // activeStream) map on reconnect without re-querying per stream.
  async findActiveByBotInstance(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string }
  ): Promise<BotRuntimeSessionLink[]> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND instance_id = ${params.instanceId} AND status = 'active'`
    )
    return result.rows.map(mapSessionLink)
  },
}

/**
 * Canonical sealed-stream claim gate (§2.6), as a reusable predicate fragment
 * correlated to a `bot_invocations` row source aliased `i`. Single source of
 * truth shared by `claimOne` (which acts on a row) and `findBootstrapInvocations`
 * (which advertises the same rows as available) so the two can never diverge —
 * a row offered as available must be one a follow-up claim can actually win.
 *
 * A plaintext invocation (no `e2e_streams` row for the root) is claimable by any
 * instance, as before; an E2E one only by the claiming instance's registered BIK
 * when the stream's wraps cover BOTH the reply generation (current) and the
 * prompt's (the trigger envelope's), mirroring the enclave's `claimNext`
 * two-EXISTS. A keyless instance (`public_key_id` NULL) never matches, so it
 * cannot claim a sealed turn it has no key to open. Conditional because this
 * gate is applied on a path that also serves plaintext streams.
 *
 * Built with squid `sql` so it carries `$1..$k` placeholders that
 * {@link composeSql} renumbers when splicing it into a larger query.
 */
function sealedStreamClaimGateSql(instanceId: string): QueryConfig {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM e2e_streams e
      WHERE e.workspace_id = i.workspace_id AND e.stream_id = i.root_stream_id
    )
    OR (
      EXISTS (
        SELECT 1 FROM stream_e2e_key_wraps w
        JOIN e2e_streams e
          ON e.workspace_id = i.workspace_id AND e.stream_id = i.root_stream_id
        JOIN bot_runtime_instances ri
          ON ri.workspace_id = i.workspace_id AND ri.bot_id = i.actor_id AND ri.instance_id = ${instanceId}
        WHERE w.workspace_id = i.workspace_id
          AND w.stream_id = i.root_stream_id
          AND w.recipient_kind = 'bot'
          AND w.recipient_key_id = ri.public_key_id
          AND w.key_generation = e.current_key_generation
      )
      AND (
        -- A session-control invocation (e.g. slash-model) has no sealed trigger
        -- to open: its source_message_id is a command event, not a sealed
        -- messages row, so only the reply/ack generation (checked above) must be
        -- covered. Requiring trigger coverage here would leave every
        -- session-control invocation on an E2E stream permanently unclaimable.
        i.trigger = 'session-control'
        OR EXISTS (
          SELECT 1 FROM stream_e2e_key_wraps w
          -- messages has no workspace_id column (it is scoped by stream_id); the
          -- join on the globally-unique source message id is the invocation's own
          -- trigger, so it stays tenant-safe without one (as enclave claimNext does).
          JOIN messages m ON m.id = i.source_message_id
          JOIN bot_runtime_instances ri
            ON ri.workspace_id = i.workspace_id AND ri.bot_id = i.actor_id AND ri.instance_id = ${instanceId}
          WHERE w.workspace_id = i.workspace_id
            AND w.stream_id = i.root_stream_id
            AND w.recipient_kind = 'bot'
            AND w.recipient_key_id = ri.public_key_id
            AND w.key_generation = (m.envelope ->> 'keyGeneration')::int
        )
      )
    )
  )`
}

/** `ORDER BY` is stable so the repair loop makes progress across batches. */
async function queryDeletedSourcesWithRunningSessions(
  db: Querier,
  options: { workspaceId?: string; sessionId?: string; limit?: number }
): Promise<Array<{ workspaceId: string; sourceMessageId: string }>> {
  const result = await db.query<{ workspace_id: string; source_message_id: string }>(sql`
    SELECT DISTINCT i.workspace_id, i.source_message_id
    FROM bot_invocations i
    JOIN agent_sessions s ON s.id = i.id
    WHERE i.status = 'cancelled'
      AND i.cancellation_reason = 'source_deleted'
      AND s.status = 'running'
      AND (${options.sessionId ?? null}::text IS NULL OR i.id = ${options.sessionId ?? null})
      AND (${options.workspaceId ?? null}::text IS NULL OR i.workspace_id = ${options.workspaceId ?? null})
    ORDER BY i.workspace_id, i.source_message_id
    LIMIT ${options.limit ?? null}
  `)
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    sourceMessageId: row.source_message_id,
  }))
}

export const BotInvocationRepository = {
  async isBotInvocationSession(db: Querier, workspaceId: string, sessionId: string): Promise<boolean> {
    const result = await db.query<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM bot_invocations WHERE id = ${sessionId} AND workspace_id = ${workspaceId}) AS exists
    `)
    return result.rows[0]?.exists ?? false
  },

  async findDeletedSourceForRunningSession(
    db: Querier,
    params: { workspaceId: string; sessionId: string }
  ): Promise<{ workspaceId: string; sourceMessageId: string } | null> {
    const rows = await queryDeletedSourcesWithRunningSessions(db, params)
    return rows[0] ?? null
  },

  async findDeletedSourcesWithRunningSessions(
    db: Querier,
    limit: number
  ): Promise<Array<{ workspaceId: string; sourceMessageId: string }>> {
    return queryDeletedSourcesWithRunningSessions(db, { limit })
  },

  /** Source lock first, actor locks second: the order every route insert and terminal transition takes. */
  async lockSource(db: Querier, identity: BotInvocationSourceIdentity): Promise<void> {
    await acquireSourceLocks(db, [identity])
  },

  async cancelActiveRoutesNotDesired(
    db: Querier,
    params: {
      workspaceId: string
      sourceMessageId: string
      sourceMessageRevision: number
      desiredRoutes: DesiredInvocationRouteIdentity[]
    },
    options: { locksHeld?: boolean } = {}
  ): Promise<BotInvocation[]> {
    return withTransactionIfPool(db, async (lockedDb) => {
      const sourceIdentity = { workspaceId: params.workspaceId, sourceMessageId: params.sourceMessageId }
      // Every insert and terminal transition takes this coarser source lock
      // before its actor lock. Take it before reading/cancelling active routes
      // so a route-changing edit can never hold an invocation row while waiting
      // on a completion that already holds the actor lock (INV-20).
      if (!options.locksHeld) {
        await acquireSourceLocks(lockedDb, [sourceIdentity])
        const active = await lockedDb.query<BotInvocationActorSourceRow>(sql`
          SELECT DISTINCT workspace_id, source_message_id, actor_type, actor_id
          FROM bot_invocations
          WHERE workspace_id = ${params.workspaceId}
            AND source_message_id = ${params.sourceMessageId}
            AND status IN ('pending', 'claimed')
        `)
        await acquireActorLocks(lockedDb, [
          ...active.rows.map(mapActorSourceIdentity),
          ...params.desiredRoutes.map((route) => ({ ...sourceIdentity, ...route, actorType: "bot" })),
        ])
      }
      const result = await lockedDb.query<BotInvocationRow>(sql`
        UPDATE bot_invocations i
        SET status = 'cancelled', cancellation_reason = 'routing_changed',
            source_message_revision = GREATEST(source_message_revision, ${params.sourceMessageRevision}), updated_at = NOW()
        WHERE i.workspace_id = ${params.workspaceId}
          AND i.source_message_id = ${params.sourceMessageId}
          AND i.status IN ('pending', 'claimed')
          AND i.trigger <> 'session-control'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${JSON.stringify(params.desiredRoutes)}::jsonb) desired
            WHERE desired ->> 'actorId' = i.actor_id
              AND desired ->> 'trigger' = i.trigger
              AND (
                i.status = 'pending'
                OR (
                  desired ->> 'activeStreamId' = i.active_stream_id
                  AND desired ->> 'responseStreamId' = i.response_stream_id
                  AND (desired ->> 'targetInstanceId') IS NOT DISTINCT FROM i.target_instance_id
                  AND (desired ->> 'targetRuntimeSessionId') IS NOT DISTINCT FROM i.target_runtime_session_id
                )
              )
          )
        RETURNING i.*
      `)
      return result.rows.map(mapInvocation)
    })
  },

  /**
   * Every guard is applied only when the caller supplies it: a guard that silently defaulted would
   * widen the fence and let a stale writer clobber a claim that has already been replaced (INV-20).
   */
  async cancelClaim(
    db: Querier,
    params: {
      workspaceId: string
      invocationId: string
      reason: BotInvocationCancellationReason
      botId?: string
      instanceId?: string
      claimToken?: string
      expectedClaimedRevision?: number
      expectedSourceRevision?: number
      bumpToRevision?: number
    }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`
      UPDATE bot_invocations
      SET status = 'cancelled', cancellation_reason = ${params.reason},
          source_message_revision = GREATEST(
            source_message_revision,
            COALESCE(${params.bumpToRevision ?? null}::int, source_message_revision)
          ),
          updated_at = NOW()
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND status = 'claimed'
        AND (${params.botId ?? null}::text IS NULL OR (actor_type = 'bot' AND actor_id = ${params.botId ?? null}))
        AND (${params.instanceId ?? null}::text IS NULL OR claimed_by_instance_id = ${params.instanceId ?? null})
        AND (${params.claimToken ?? null}::text IS NULL OR claim_token = ${params.claimToken ?? null})
        AND (
          ${params.expectedClaimedRevision ?? null}::int IS NULL
          OR claimed_source_message_revision = ${params.expectedClaimedRevision ?? null}
        )
        AND (
          ${params.expectedSourceRevision ?? null}::int IS NULL
          OR source_message_revision = ${params.expectedSourceRevision ?? null}
        )
      RETURNING *
    `)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  /**
   * Claimed rows are cancelled here too, unlike a routing change: the session
   * this invocation names is ending, so its turn will never complete and the
   * target filter on the claim query means no other session may take it over.
   * Rows merely claimed BY that session with no target are left alone — those
   * fall back to any claimer once the claim expires.
   */
  async cancelActiveByTargetRuntimeSession(
    db: Querier,
    params: { workspaceId: string; botId: string; runtimeSessionId: string }
  ): Promise<BotInvocation[]> {
    const result = await db.query<BotInvocationRow>(sql`
      UPDATE bot_invocations
      SET status = 'cancelled', cancellation_reason = 'routing_changed', updated_at = NOW()
      WHERE workspace_id = ${params.workspaceId}
        AND actor_type = 'bot' AND actor_id = ${params.botId}
        AND status IN ('pending', 'claimed')
        AND target_runtime_session_id = ${params.runtimeSessionId}
      RETURNING *
    `)
    return result.rows.map(mapInvocation)
  },

  async cancelActiveBySource(
    db: Querier,
    params: { workspaceId: string; sourceMessageId: string; reason: string },
    options: { locksHeld?: boolean } = {}
  ): Promise<{ transitioned: BotInvocation[]; sessionRepairCandidates: BotInvocation[] }> {
    return withTransactionIfPool(db, async (lockedDb) => {
      const sourceIdentity = { workspaceId: params.workspaceId, sourceMessageId: params.sourceMessageId }
      if (!options.locksHeld) {
        await acquireSourceLocks(lockedDb, [sourceIdentity])
        const active = await lockedDb.query<BotInvocationActorSourceRow>(sql`
          SELECT DISTINCT workspace_id, source_message_id, actor_type, actor_id
          FROM bot_invocations
          WHERE workspace_id = ${params.workspaceId}
            AND source_message_id = ${params.sourceMessageId}
            AND status IN ('pending', 'claimed')
        `)
        await acquireActorLocks(lockedDb, active.rows.map(mapActorSourceIdentity))
      }
      const transitionedResult = await lockedDb.query<BotInvocationRow>(sql`
        UPDATE bot_invocations
        SET status = 'cancelled', cancellation_reason = ${params.reason},
            source_message_revision = GREATEST(source_message_revision, COALESCE((
              SELECT m.revision FROM messages m JOIN streams s ON s.id = m.stream_id
              WHERE m.id = bot_invocations.source_message_id AND s.workspace_id = bot_invocations.workspace_id
            ), source_message_revision)), updated_at = NOW()
        WHERE workspace_id = ${params.workspaceId} AND source_message_id = ${params.sourceMessageId}
          AND status IN ('pending', 'claimed')
        RETURNING *
      `)
      const repairResult = await lockedDb.query<BotInvocationRow>(sql`
        SELECT i.* FROM bot_invocations i
        JOIN agent_sessions session ON session.id = i.id AND session.status IN ('running', 'completed')
        WHERE i.workspace_id = ${params.workspaceId} AND i.source_message_id = ${params.sourceMessageId}
          AND (
            (i.status = 'cancelled' AND i.cancellation_reason = ${params.reason})
            OR i.status = 'completed'
          )
          AND NOT (i.id = ANY(${transitionedResult.rows.map((row) => row.id)}))
      `)
      return {
        transitioned: transitionedResult.rows.map(mapInvocation),
        sessionRepairCandidates: repairResult.rows.map(mapInvocation),
      }
    })
  },

  async listCompletedTurnRevisionsBySource(
    db: Querier,
    params: { workspaceId: string; sourceMessageId: string; actorIds: string[] }
  ): Promise<Map<string, number>> {
    const result = await db.query<{ actor_id: string; revision: number }>(sql`
      SELECT actor_id, MAX(source_message_revision) AS revision
      FROM bot_invocations
      WHERE workspace_id = ${params.workspaceId}
        AND source_message_id = ${params.sourceMessageId}
        AND actor_type = 'bot'
        AND actor_id = ANY(${params.actorIds})
        AND status = 'completed'
      GROUP BY actor_id
    `)
    return new Map(result.rows.map((row) => [row.actor_id, Number(row.revision)]))
  },

  async insertIdempotent(
    db: Querier,
    params: Omit<
      BotInvocation,
      | "status"
      | "claimedByInstanceId"
      | "claimedRuntimeSessionId"
      | "claimedRuntimeSessionClaimToken"
      | "claimToken"
      | "claimExpiresAt"
      | "attempts"
      | "claimedSourceMessageRevision"
      | "claimedInputUpdateMode"
      | "cancellationReason"
      | "errorMessage"
      | "createdAt"
      | "updatedAt"
      | "completedAt"
    >,
    options: { locksHeld?: boolean } = {}
  ): Promise<{
    invocation: BotInvocation
    wasNewlyInserted: boolean
    didAdvanceSourceRevision?: boolean
    routingDestinationChanged?: boolean
  }> {
    // `xmax = 0` is the Postgres idiom for "this row was inserted, not updated"
    // — it stays zero on a fresh INSERT and becomes non-zero on ON CONFLICT DO
    // UPDATE, even when the UPDATE writes the same value. Lets callers (the
    // bot-runtime service) decide whether to emit `bot_invocation:available`
    // without paying for a pre-check round-trip.
    return withTransactionIfPool(db, async (lockedDb) => {
      if (!options.locksHeld) await acquireActorSourceLocks(lockedDb, [params])
      const previous = await lockedDb.query<BotInvocationRow>(sql`
        SELECT * FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId} AND source_message_id = ${params.sourceMessageId}
          AND actor_type = ${params.actorType} AND actor_id = ${params.actorId}
          AND trigger = ${params.trigger} AND status IN ('pending', 'claimed')
        LIMIT 1
      `)
      const result =
        await lockedDb.query<BotInvocationRowWithInsertMarker>(sql`INSERT INTO bot_invocations (id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id, actor_type, actor_id, trigger, required_capability, prompt_markdown, author_user_id, mentioned_actor_slugs, target_instance_id, target_runtime_session_id, metadata, source_message_revision)
        SELECT ${params.id}, ${params.workspaceId}, ${params.rootStreamId}, ${params.activeStreamId}, ${params.sourceMessageId}, ${params.responseStreamId}, ${params.actorType}, ${params.actorId}, ${params.trigger}, ${params.requiredCapability}, ${params.promptMarkdown}, ${params.authorUserId}, ${params.mentionedActorSlugs}, ${params.targetInstanceId}, ${params.targetRuntimeSessionId}, ${params.metadata}, ${params.sourceMessageRevision}
        WHERE ${params.trigger} = 'session-control' OR NOT EXISTS (
          SELECT 1 FROM bot_invocations terminal
          WHERE terminal.workspace_id = ${params.workspaceId}
            AND terminal.source_message_id = ${params.sourceMessageId}
            AND terminal.actor_type = ${params.actorType}
            AND terminal.actor_id = ${params.actorId}
            AND terminal.status IN ('completed', 'failed', 'parked', 'expired')
            AND terminal.source_message_revision >= ${params.sourceMessageRevision}
        )
        ON CONFLICT (workspace_id, source_message_id, actor_type, actor_id, trigger) WHERE status IN ('pending', 'claimed') DO UPDATE SET
          prompt_markdown = CASE
            WHEN bot_invocations.status = 'pending' OR bot_invocations.claimed_input_update_mode = 'live' THEN EXCLUDED.prompt_markdown
            ELSE bot_invocations.prompt_markdown
          END,
          mentioned_actor_slugs = CASE
            WHEN bot_invocations.status = 'pending' OR bot_invocations.claimed_input_update_mode = 'live' THEN EXCLUDED.mentioned_actor_slugs
            ELSE bot_invocations.mentioned_actor_slugs
          END,
          active_stream_id = CASE
            WHEN bot_invocations.status = 'pending' THEN EXCLUDED.active_stream_id
            ELSE bot_invocations.active_stream_id
          END,
          response_stream_id = CASE
            WHEN bot_invocations.status = 'pending' THEN EXCLUDED.response_stream_id
            ELSE bot_invocations.response_stream_id
          END,
          target_instance_id = CASE
            WHEN bot_invocations.status = 'pending' THEN EXCLUDED.target_instance_id
            ELSE bot_invocations.target_instance_id
          END,
          target_runtime_session_id = CASE
            WHEN bot_invocations.status = 'pending' THEN EXCLUDED.target_runtime_session_id
            ELSE bot_invocations.target_runtime_session_id
          END,
          source_message_revision = EXCLUDED.source_message_revision,
          attempts = CASE WHEN bot_invocations.status = 'claimed' THEN 0 ELSE bot_invocations.attempts END,
          updated_at = NOW()
        WHERE bot_invocations.source_message_revision < EXCLUDED.source_message_revision
        RETURNING *, (xmax = 0) AS was_newly_inserted`)
      const row = result.rows[0]
      if (row) {
        const prior = previous.rows[0]
        const routingDestinationChanged =
          !row.was_newly_inserted &&
          prior?.status === "pending" &&
          (prior.active_stream_id !== params.activeStreamId ||
            prior.response_stream_id !== params.responseStreamId ||
            prior.target_instance_id !== params.targetInstanceId ||
            prior.target_runtime_session_id !== params.targetRuntimeSessionId)
        return {
          invocation: mapInvocation(row),
          wasNewlyInserted: row.was_newly_inserted,
          didAdvanceSourceRevision: !row.was_newly_inserted,
          routingDestinationChanged,
        }
      }
      const existing = await lockedDb.query<BotInvocationRow>(sql`
        SELECT * FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId} AND source_message_id = ${params.sourceMessageId}
          AND actor_type = ${params.actorType} AND actor_id = ${params.actorId}
          AND (
            (trigger = ${params.trigger} AND status IN ('pending', 'claimed'))
            OR status IN ('completed', 'failed', 'parked', 'expired')
          )
        ORDER BY CASE WHEN status IN ('pending', 'claimed') THEN 0 ELSE 1 END, created_at DESC
        LIMIT 1
      `)
      if (!existing.rows[0]) throw new Error(`Active invocation conflict disappeared for ${params.sourceMessageId}`)
      return {
        invocation: mapInvocation(existing.rows[0]),
        wasNewlyInserted: false,
        didAdvanceSourceRevision: false,
        routingDestinationChanged: false,
      }
    })
  },

  async findNextClaimable(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      instanceId: string
      runtimeSessionId?: string
      runtimeKind: BotRuntimeKind
      supportedCapabilities: BotInvocationCapability[]
      maxAttempts: number
      responseStreamId?: string
    }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(composeSql`SELECT i.* FROM bot_invocations i
      WHERE i.workspace_id = ${params.workspaceId}
        AND i.actor_type = 'bot'
        AND i.actor_id = ${params.botId}
        AND i.required_capability = ANY(${params.supportedCapabilities})
        AND EXISTS (
          SELECT 1 FROM bot_runtime_instances r
          WHERE r.workspace_id = ${params.workspaceId}
            AND r.bot_id = ${params.botId}
            AND r.instance_id = ${params.instanceId}
            AND r.runtime_kind = ${params.runtimeKind}
        )
        AND (i.target_instance_id IS NULL OR i.target_instance_id = ${params.instanceId})
        AND (i.target_runtime_session_id IS NULL OR i.target_runtime_session_id = ${params.runtimeSessionId ?? null})
        AND (i.status = 'pending' OR (i.status = 'claimed' AND i.claim_expires_at < NOW()))
        AND (${params.responseStreamId ?? null}::text IS NULL OR i.response_stream_id = ${params.responseStreamId ?? null})
        AND i.attempts < ${params.maxAttempts}
        AND ${sealedStreamClaimGateSql(params.instanceId)}
      ORDER BY i.created_at ASC, CASE WHEN i.trigger = 'session-control' THEN 1 ELSE 0 END ASC, i.id ASC
      LIMIT 1`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async claimOne(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      instanceId: string
      runtimeSessionId?: string
      runtimeKind: BotRuntimeKind
      claimToken: string
      supportedCapabilities: BotInvocationCapability[]
      claimTtlSeconds: number
      maxAttempts: number
      /**
       * Restrict the claim to invocations answering into this stream.
       *
       * A connector that folds several queued messages into one turn can only
       * do so for messages sharing a response stream — the turn is delivered
       * with one stream id, so folding across streams answers one question in
       * another's stream and closes the rest unanswered. Sealing needs no
       * separate predicate: sealing is a property of the stream, so one
       * response stream is uniformly sealed or uniformly plaintext.
       *
       * Without this the connector would have to claim first and inspect
       * after, and there is no way to release a claim it should not have taken.
       */
      responseStreamId?: string
    }
  ): Promise<BotInvocation | null> {
    // A composite message + steer shares one transaction timestamp; put the
    // message invocation first when both capabilities are claimable.
    const result = await db.query<BotInvocationRow>(composeSql`WITH candidate AS (
        SELECT i.id FROM bot_invocations i
        WHERE i.workspace_id = ${params.workspaceId}
          AND i.actor_type = 'bot'
          AND i.actor_id = ${params.botId}
          AND i.required_capability = ANY(${params.supportedCapabilities})
          AND EXISTS (
            SELECT 1 FROM bot_runtime_instances r
            WHERE r.workspace_id = ${params.workspaceId}
              AND r.bot_id = ${params.botId}
              AND r.instance_id = ${params.instanceId}
              AND r.runtime_kind = ${params.runtimeKind}
          )
          AND (i.target_instance_id IS NULL OR i.target_instance_id = ${params.instanceId})
          AND (i.target_runtime_session_id IS NULL OR i.target_runtime_session_id = ${params.runtimeSessionId ?? null})
          AND (i.status = 'pending' OR (i.status = 'claimed' AND i.claim_expires_at < NOW()))
          AND (${params.responseStreamId ?? null}::text IS NULL OR i.response_stream_id = ${params.responseStreamId ?? null})
          AND i.attempts < ${params.maxAttempts}
          AND ${sealedStreamClaimGateSql(params.instanceId)}
        ORDER BY i.created_at ASC, CASE WHEN i.trigger = 'session-control' THEN 1 ELSE 0 END ASC, i.id ASC
        FOR UPDATE OF i SKIP LOCKED
        LIMIT 1
      )
      UPDATE bot_invocations i
      SET status = 'claimed', claimed_by_instance_id = ${params.instanceId}, claimed_runtime_session_id = ${params.runtimeSessionId ?? null}, claimed_runtime_session_claim_token = ${params.claimToken}, claim_token = ${params.claimToken}, claim_expires_at = NOW() + (${params.claimTtlSeconds} || ' seconds')::interval, attempts = attempts + 1, updated_at = NOW(),
          claimed_source_message_revision = CASE WHEN i.trigger = 'session-control' THEN 0 ELSE NULL END,
          claimed_input_update_mode = (
            SELECT r.manifest -> 'input' ->> 'updates'
            FROM bot_runtime_instances r
            WHERE r.workspace_id = i.workspace_id AND r.bot_id = i.actor_id
              AND r.instance_id = ${params.instanceId} AND r.runtime_kind = ${params.runtimeKind}
          )
      FROM candidate
      WHERE i.id = candidate.id
      RETURNING i.*`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async pinClaimSource(
    db: Querier,
    params: {
      workspaceId: string
      invocationId: string
      instanceId: string
      claimToken: string
      revision: number
      promptMarkdown: string
    }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`
      UPDATE bot_invocations
      SET source_message_revision = ${params.revision},
          claimed_source_message_revision = ${params.revision},
          prompt_markdown = ${params.promptMarkdown},
          updated_at = NOW()
      WHERE id = ${params.invocationId}
        AND workspace_id = ${params.workspaceId}
        AND status = 'claimed'
        AND claimed_by_instance_id = ${params.instanceId}
        AND claim_token = ${params.claimToken}
      RETURNING *
    `)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async findActiveClaim(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; instanceId: string; claimToken: string }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId} AND status = 'claimed' AND claimed_by_instance_id = ${params.instanceId} AND claim_token = ${params.claimToken} AND claim_expires_at > NOW()`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async findForCallback(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; instanceId?: string; claimToken: string }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
      WHERE id = ${params.invocationId}
        AND workspace_id = ${params.workspaceId}
        AND actor_type = 'bot'
        AND actor_id = ${params.botId}
        AND claim_token = ${params.claimToken}
        AND (${params.instanceId ?? null}::text IS NULL OR claimed_by_instance_id = ${params.instanceId ?? null})
        AND (status = 'completed' OR (status = 'claimed' AND claim_expires_at > NOW()))`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async findActiveClaimForUpdate(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; instanceId?: string; claimToken: string }
  ): Promise<BotInvocation | null> {
    return withTransactionIfPool(db, async (lockedDb) => {
      const identity = await findInvocationActorSource(lockedDb, params)
      if (!identity) return null
      await acquireActorSourceLocks(lockedDb, [identity])
      const result = await lockedDb.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
        WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId} AND status = 'claimed' AND (${params.instanceId ?? null}::text IS NULL OR claimed_by_instance_id = ${params.instanceId ?? null}) AND claim_token = ${params.claimToken} AND claim_expires_at > NOW()
        FOR UPDATE`)
      return result.rows[0] ? mapInvocation(result.rows[0]) : null
    })
  },

  async findCompletedForReplay(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      claimToken: string
      instanceId?: string
    }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
      WHERE id = ${params.invocationId}
        AND workspace_id = ${params.workspaceId}
        AND actor_type = 'bot'
        AND actor_id = ${params.botId}
        AND status = 'completed'
        AND claim_token = ${params.claimToken}
        AND (${params.instanceId ?? null}::text IS NULL OR claimed_by_instance_id = ${params.instanceId ?? null})
      FOR UPDATE`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  /**
   * `locksHeld`: the caller already holds the source and actor advisory locks, so this must not
   * re-acquire them, and it takes `FOR UPDATE` because it re-reads the row it is about to renew —
   * the two always move together.
   */
  async findClaimControl(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; instanceId: string; claimToken: string },
    options: { locksHeld?: boolean } = {}
  ): Promise<BotInvocation | null> {
    if (!options.locksHeld) {
      const identity = await findInvocationActorSource(db, params)
      if (!identity) return null
      await acquireActorSourceLocks(db, [identity])
    }
    const rowLockSql: QueryConfig = { text: options.locksHeld ? "FOR UPDATE" : "", values: [] }
    const result = await db.query<BotInvocationRow>(composeSql`SELECT * FROM bot_invocations
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId}
        AND actor_type = 'bot' AND actor_id = ${params.botId}
        AND claimed_by_instance_id = ${params.instanceId} AND claim_token = ${params.claimToken}
        AND status IN ('claimed', 'cancelled')
      ${rowLockSql}`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async renewClaim(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId: string
      claimToken: string
      claimTtlSeconds: number
    }
  ): Promise<BotInvocation | null> {
    const result =
      await db.query<BotInvocationRow>(sql`UPDATE bot_invocations SET claim_expires_at = NOW() + (${params.claimTtlSeconds} || ' seconds')::interval, updated_at = NOW()
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId} AND status = 'claimed' AND claimed_by_instance_id = ${params.instanceId} AND claim_token = ${params.claimToken} AND claim_expires_at > NOW()
      RETURNING *`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  // `instanceId` is optional and null-guarded: the plaintext path scopes the
  // completion to the claiming instance, while the sealed bot path authenticates
  // by the per-claim callback token (the `claim_token` filter below) and omits
  // it — the token is the unique per-claim secret, so the instance is redundant
  // there. Identical SQL when an instance is supplied.
  async completeClaim(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId?: string
      claimToken: string
      sourceRevision: number
    },
    options: { locksHeld?: boolean } = {}
  ): Promise<BotInvocation | null> {
    return withTransactionIfPool(db, async (lockedDb) => {
      const identity = await findInvocationActorSource(lockedDb, params)
      if (!identity) return null
      if (!options.locksHeld) await acquireActorSourceLocks(lockedDb, [identity])
      if (identity.trigger !== "session-control" && !(await lockCanonicalInvocationSource(lockedDb, params)))
        return null
      const result =
        await lockedDb.query<BotInvocationRow>(composeSql`UPDATE bot_invocations i SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE i.id = ${params.invocationId} AND i.workspace_id = ${params.workspaceId} AND i.actor_type = 'bot' AND i.actor_id = ${params.botId} AND i.status = 'claimed' AND i.claim_token = ${params.claimToken} AND (${params.instanceId ?? null}::text IS NULL OR i.claimed_by_instance_id = ${params.instanceId ?? null}) AND i.claim_expires_at > NOW()
          AND (i.trigger = 'session-control' OR EXISTS (
            SELECT 1 FROM messages m JOIN streams s ON s.id = m.stream_id
            WHERE m.id = i.source_message_id
              AND ${canonicalSourceGateSql("i", sql`${params.sourceRevision}`)}
              AND (
                i.claimed_source_message_revision = ${params.sourceRevision}
                OR (
                  i.claimed_input_update_mode = 'live'
                  AND ${params.sourceRevision} > i.claimed_source_message_revision
                )
              )
          ))
        RETURNING i.*`)
      return result.rows[0] ? mapInvocation(result.rows[0]) : null
    })
  },

  async failClaim(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId?: string
      claimToken: string
      errorMessage: string
    }
  ): Promise<BotInvocation | null> {
    return withTransactionIfPool(db, async (lockedDb) => {
      const identity = await findInvocationActorSource(lockedDb, params)
      if (!identity) return null
      await acquireActorSourceLocks(lockedDb, [identity])
      if (identity.trigger !== "session-control" && !(await lockCanonicalInvocationSource(lockedDb, params)))
        return null
      const result =
        await lockedDb.query<BotInvocationRow>(composeSql`UPDATE bot_invocations i SET status = 'failed', error_message = ${params.errorMessage}, updated_at = NOW()
        WHERE i.id = ${params.invocationId} AND i.workspace_id = ${params.workspaceId} AND i.actor_type = 'bot' AND i.actor_id = ${params.botId} AND i.status = 'claimed' AND (${params.instanceId ?? null}::text IS NULL OR i.claimed_by_instance_id = ${params.instanceId ?? null}) AND i.claim_token = ${params.claimToken} AND i.claim_expires_at > NOW()
          AND (i.trigger = 'session-control' OR EXISTS (
            SELECT 1 FROM messages m JOIN streams s ON s.id = m.stream_id
            WHERE m.id = i.source_message_id
              AND ${canonicalSourceGateSql("i", sql`i.claimed_source_message_revision`)}
          ))
        RETURNING i.*`)
      return result.rows[0] ? mapInvocation(result.rows[0]) : null
    })
  },

  /**
   * Dead-letter every invocation for this bot that has exhausted its claim
   * budget — `claimed` with an expired claim and `attempts >= maxAttempts`, so
   * `claimOne` will never pick it up again. Moves them to terminal `parked`
   * with an explanatory `error_message` (preserving any failure the runtime
   * already reported). Run on the claim loop so a wedged invocation is reaped
   * at the same cadence the work is polled. Returns the rows it parked so the
   * caller can log them. Idempotent under concurrent claimers: the
   * `status = 'claimed'` predicate means a second runner's UPDATE no-ops once
   * the first has flipped the row to `parked` (INV-20).
   */
  async parkExhausted(
    db: Querier,
    params: { workspaceId: string; botId: string; maxAttempts: number }
  ): Promise<BotInvocation[]> {
    return withTransactionIfPool(db, async (lockedDb) => {
      const candidates = await lockedDb.query<BotInvocationActorSourceRow & { id: string; trigger: string }>(sql`
        SELECT id, workspace_id, source_message_id, actor_type, actor_id, trigger
        FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND status = 'claimed'
          AND claim_expires_at < NOW()
          AND attempts >= ${params.maxAttempts}
      `)
      if (candidates.rows.length === 0) return []

      await acquireActorSourceLocks(lockedDb, candidates.rows.map(mapActorSourceIdentity))
      const sessionControlIds = candidates.rows.filter((row) => row.trigger === "session-control").map((row) => row.id)
      const messageCandidateIds = candidates.rows
        .filter((row) => row.trigger !== "session-control")
        .map((row) => row.id)
      const canonicalMessageCandidates =
        messageCandidateIds.length === 0
          ? []
          : (
              await lockedDb.query<{ id: string }>(composeSql`
                SELECT i.id
                FROM bot_invocations i
                JOIN messages m ON m.id = i.source_message_id
                JOIN streams s ON s.id = m.stream_id
                WHERE i.id = ANY(${messageCandidateIds})
                  AND i.workspace_id = ${params.workspaceId}
                  AND i.actor_type = 'bot'
                  AND i.actor_id = ${params.botId}
                  AND ${canonicalSourceGateSql("i", sql`i.claimed_source_message_revision`)}
                ORDER BY m.id, i.id
                FOR SHARE OF m
              `)
            ).rows.map((row) => row.id)
      const candidateIds = [...sessionControlIds, ...canonicalMessageCandidates]
      if (candidateIds.length === 0) return []
      const result = await lockedDb.query<BotInvocationRow>(composeSql`UPDATE bot_invocations
        SET status = 'parked', error_message = COALESCE(error_message, 'Claim attempts exhausted without completion'), updated_at = NOW()
        WHERE id = ANY(${candidateIds})
          AND workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND status = 'claimed'
          AND claim_expires_at < NOW()
          AND attempts >= ${params.maxAttempts}
          AND (
            trigger = 'session-control'
            OR EXISTS (
              SELECT 1 FROM messages m JOIN streams s ON s.id = m.stream_id
              WHERE m.id = bot_invocations.source_message_id
                AND ${canonicalSourceGateSql("bot_invocations", sql`bot_invocations.claimed_source_message_revision`)}
            )
          )
        RETURNING *`)
      return result.rows.map(mapInvocation)
    })
  },

  /**
   * Snapshot for `/bot` namespace bootstrap. Returns two disjoint lists:
   *  - `available`: rows this runtime could claim right now (pending, or
   *    `claimed` with an expired claim, and not yet attempt-exhausted)
   *    filtered to its capabilities and the steering target. Mirrors
   *    `claimOne`'s claimability predicate so a row advertised here is one a
   *    follow-up claim can actually win. Used to replay anything that piled
   *    up while the socket was offline.
   *  - `ownedClaims`: live `claimed` rows already owned by this instance.
   *    Returned regardless of `since` so a reconnect cannot drop work that
   *    is in flight.
   *
   * `since` filters `available` only. The 24h floor is enforced one layer
   * up in `BotRuntimeService.getBootstrapForRuntime` — direct callers can
   * pass `null` to skip filtering entirely, but the production path
   * always passes a concrete `Date`.
   */
  async findBootstrapInvocations(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      instanceId: string
      runtimeSessionId: string | null
      supportedCapabilities: BotInvocationCapability[]
      since: Date | null
      maxAttempts: number
    }
  ): Promise<{
    available: BotInvocation[]
    ownedClaims: BotInvocation[]
    recentCancellations: BotInvocationCancellation[]
  }> {
    // Bootstrap order must match claimOne for same-timestamp message + steer rows.
    const availableResult = await db.query<BotInvocationRow>(composeSql`SELECT i.* FROM bot_invocations i
        WHERE i.workspace_id = ${params.workspaceId}
          AND i.actor_type = 'bot'
          AND i.actor_id = ${params.botId}
          AND i.required_capability = ANY(${params.supportedCapabilities})
          AND (i.target_instance_id IS NULL OR i.target_instance_id = ${params.instanceId})
          AND (i.target_runtime_session_id IS NULL OR i.target_runtime_session_id = ${params.runtimeSessionId})
          AND (i.status = 'pending' OR (i.status = 'claimed' AND i.claim_expires_at < NOW()))
          AND i.attempts < ${params.maxAttempts}
          AND (${params.since}::timestamptz IS NULL OR i.created_at >= ${params.since})
          AND ${sealedStreamClaimGateSql(params.instanceId)}
        ORDER BY i.created_at ASC, CASE WHEN i.trigger = 'session-control' THEN 1 ELSE 0 END ASC, i.id ASC
        LIMIT 200`)
    const ownedClaimsResult = await db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND status = 'claimed'
          AND claimed_by_instance_id = ${params.instanceId}
          AND claimed_runtime_session_id IS NOT DISTINCT FROM ${params.runtimeSessionId}
          AND claim_expires_at > NOW()
        ORDER BY created_at ASC, id ASC
        LIMIT 200`)
    const cancellationResult = await db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND status = 'cancelled'
          AND cancellation_reason IS NOT NULL
          AND claimed_by_instance_id = ${params.instanceId}
          AND claimed_runtime_session_id IS NOT DISTINCT FROM ${params.runtimeSessionId}
          AND (${params.since}::timestamptz IS NULL OR updated_at >= ${params.since})
        ORDER BY updated_at DESC, id DESC
        LIMIT 200`)
    return {
      available: availableResult.rows.map(mapInvocation),
      ownedClaims: ownedClaimsResult.rows.map(mapInvocation),
      recentCancellations: cancellationResult.rows.map(mapInvocation).map((invocation) => {
        const target = resolveControlTarget(invocation)
        return {
          invocationId: invocation.id,
          sourceRevision: invocation.sourceMessageRevision,
          reason: invocation.cancellationReason!,
          targetInstanceId: target.targetInstanceId!,
          targetRuntimeSessionId: target.targetRuntimeSessionId,
        }
      }),
    }
  },
}
