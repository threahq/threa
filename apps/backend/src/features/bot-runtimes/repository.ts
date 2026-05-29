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
  type BotRuntimeKind,
  type BotRuntimeSessionLinkStatus,
  type BotRuntimeStatus,
} from "@threa/types"
import { sql, type Querier } from "../../db"

export type RuntimeSessionLinkStatus = BotRuntimeSessionLinkStatus

/**
 * How recently a bot runtime instance must have been seen for its BIK to be
 * wrapped into a stream's SSK roll. Matches the enclave staleness window so the
 * two actor kinds share one notion of "live enough to receive key material".
 */
export const BOT_RUNTIME_BIK_STALENESS_MS = 2 * 60 * 1000

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
  authorUserId: string
  mentionedActorSlugs: string[]
  status: BotInvocationStatus
  targetInstanceId: string | null
  targetRuntimeSessionId: string | null
  claimedByInstanceId: string | null
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
  author_user_id: string
  mentioned_actor_slugs: string[]
  status: string
  target_instance_id: string | null
  target_runtime_session_id: string | null
  claimed_by_instance_id: string | null
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
    authorUserId: row.author_user_id,
    mentionedActorSlugs: row.mentioned_actor_slugs,
    status: row.status as BotInvocationStatus,
    targetInstanceId: row.target_instance_id,
    targetRuntimeSessionId: row.target_runtime_session_id,
    claimedByInstanceId: row.claimed_by_instance_id,
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
      statusText?: string | null
      publicKey?: string | null
      publicKeyId?: string | null
      mergeCapabilities?: boolean
    }
  ): Promise<BotRuntimeInstance> {
    // BIK columns use COALESCE(EXCLUDED, existing) on conflict so a presence
    // upsert that doesn't carry a key (invocation-side touch, session-link
    // path) preserves a key an earlier session registered, while a session
    // start that does carry one rotates it. Clearing a key is out of scope —
    // a wrap to a retired BIK is simply undecryptable, same as revocation.
    const publicKey = params.publicKey ?? null
    const publicKeyId = params.publicKeyId ?? null
    const result = params.mergeCapabilities
      ? await db.query<BotRuntimeInstanceRow>(sql`INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, runtime_kind, instance_id, display_name, status, accepting_invocations, capabilities, status_text, public_key, public_key_id)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.runtimeKind}, ${params.instanceId}, ${params.displayName ?? null}, ${params.status}, ${params.acceptingInvocations}, ${params.capabilities}, ${params.statusText ?? null}, ${publicKey}, ${publicKeyId})
      ON CONFLICT (workspace_id, bot_id, instance_id) DO UPDATE SET runtime_kind = EXCLUDED.runtime_kind, display_name = EXCLUDED.display_name, status = EXCLUDED.status, accepting_invocations = EXCLUDED.accepting_invocations, capabilities = bot_runtime_instances.capabilities || EXCLUDED.capabilities, status_text = EXCLUDED.status_text, public_key = COALESCE(EXCLUDED.public_key, bot_runtime_instances.public_key), public_key_id = COALESCE(EXCLUDED.public_key_id, bot_runtime_instances.public_key_id), last_seen_at = NOW(), updated_at = NOW()
      RETURNING *`)
      : await db.query<BotRuntimeInstanceRow>(sql`INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, runtime_kind, instance_id, display_name, status, accepting_invocations, capabilities, status_text, public_key, public_key_id)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.runtimeKind}, ${params.instanceId}, ${params.displayName ?? null}, ${params.status}, ${params.acceptingInvocations}, ${params.capabilities}, ${params.statusText ?? null}, ${publicKey}, ${publicKeyId})
      ON CONFLICT (workspace_id, bot_id, instance_id) DO UPDATE SET runtime_kind = EXCLUDED.runtime_kind, display_name = EXCLUDED.display_name, status = EXCLUDED.status, accepting_invocations = EXCLUDED.accepting_invocations, capabilities = EXCLUDED.capabilities, status_text = EXCLUDED.status_text, public_key = COALESCE(EXCLUDED.public_key, bot_runtime_instances.public_key), public_key_id = COALESCE(EXCLUDED.public_key_id, bot_runtime_instances.public_key_id), last_seen_at = NOW(), updated_at = NOW()
      RETURNING *`)
    return mapRuntimeInstance(result.rows[0]!)
  },

  /**
   * Mark an instance offline after its grace window expires with no
   * reconnect. Does NOT delete the row — `BotInvocationRepository.claimOne`
   * has an `EXISTS … FROM bot_runtime_instances` check for
   * `target_instance_id`-pinned invocations and would refuse to hand them
   * back when the instance reconnects later if we deleted the row.
   */
  async markOffline(db: Querier, params: { workspaceId: string; botId: string; instanceId: string }): Promise<void> {
    await db.query(
      sql`UPDATE bot_runtime_instances
        SET status = 'offline', accepting_invocations = FALSE, last_seen_at = NOW(), updated_at = NOW()
        WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND instance_id = ${params.instanceId}`
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

  async findActiveByStream(
    db: Querier,
    params: { workspaceId: string; botId: string; rootStreamId: string; activeStreamId: string }
  ): Promise<BotRuntimeSessionLink | null> {
    const result = await db.query<BotRuntimeSessionLinkRow>(
      sql`SELECT * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND root_stream_id = ${params.rootStreamId} AND active_stream_id = ${params.activeStreamId} AND status = 'active'`
    )
    return result.rows[0] ? mapSessionLink(result.rows[0]) : null
  },

  async findActiveByRuntimeSession(
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
      sql`SELECT * FROM bot_runtime_session_links WHERE workspace_id = ${params.workspaceId} AND bot_id = ${params.botId} AND runtime_kind = ${params.runtimeKind} AND instance_id = ${params.instanceId} AND runtime_session_id = ${params.runtimeSessionId} AND status = 'active'`
    )
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

export const BotInvocationRepository = {
  async insertIdempotent(
    db: Querier,
    params: Omit<
      BotInvocation,
      | "status"
      | "claimedByInstanceId"
      | "claimToken"
      | "claimExpiresAt"
      | "attempts"
      | "errorMessage"
      | "createdAt"
      | "updatedAt"
      | "completedAt"
    >
  ): Promise<{ invocation: BotInvocation; wasNewlyInserted: boolean }> {
    // `xmax = 0` is the Postgres idiom for "this row was inserted, not updated"
    // — it stays zero on a fresh INSERT and becomes non-zero on ON CONFLICT DO
    // UPDATE, even when the UPDATE writes the same value. Lets callers (the
    // bot-runtime service) decide whether to emit `bot_invocation:available`
    // without paying for a pre-check round-trip.
    const result =
      await db.query<BotInvocationRowWithInsertMarker>(sql`INSERT INTO bot_invocations (id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id, actor_type, actor_id, trigger, required_capability, prompt_markdown, author_user_id, mentioned_actor_slugs, target_instance_id, target_runtime_session_id, metadata)
      VALUES (${params.id}, ${params.workspaceId}, ${params.rootStreamId}, ${params.activeStreamId}, ${params.sourceMessageId}, ${params.responseStreamId}, ${params.actorType}, ${params.actorId}, ${params.trigger}, ${params.requiredCapability}, ${params.promptMarkdown}, ${params.authorUserId}, ${params.mentionedActorSlugs}, ${params.targetInstanceId}, ${params.targetRuntimeSessionId}, ${params.metadata})
      ON CONFLICT (workspace_id, source_message_id, actor_type, actor_id, trigger) DO UPDATE SET updated_at = bot_invocations.updated_at
      RETURNING *, (xmax = 0) AS was_newly_inserted`)
    const row = result.rows[0]!
    return { invocation: mapInvocation(row), wasNewlyInserted: row.was_newly_inserted }
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
    }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`WITH candidate AS (
        SELECT id FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND required_capability = ANY(${params.supportedCapabilities})
          AND EXISTS (
            SELECT 1 FROM bot_runtime_instances r
            WHERE r.workspace_id = ${params.workspaceId}
              AND r.bot_id = ${params.botId}
              AND r.instance_id = ${params.instanceId}
              AND r.runtime_kind = ${params.runtimeKind}
          )
          AND (target_instance_id IS NULL OR target_instance_id = ${params.instanceId})
          AND (target_runtime_session_id IS NULL OR target_runtime_session_id = ${params.runtimeSessionId ?? null})
          AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at < NOW()))
        ORDER BY created_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE bot_invocations i
      SET status = 'claimed', claimed_by_instance_id = ${params.instanceId}, claim_token = ${params.claimToken}, claim_expires_at = NOW() + (${params.claimTtlSeconds} || ' seconds')::interval, attempts = attempts + 1, updated_at = NOW()
      FROM candidate
      WHERE i.id = candidate.id
      RETURNING i.*`)
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

  async findActiveClaimForUpdate(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; instanceId: string; claimToken: string }
  ): Promise<BotInvocation | null> {
    const result = await db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId} AND status = 'claimed' AND claimed_by_instance_id = ${params.instanceId} AND claim_token = ${params.claimToken} AND claim_expires_at > NOW()
      FOR UPDATE`)
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

  async completeClaim(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; instanceId: string; claimToken: string }
  ): Promise<BotInvocation | null> {
    const result =
      await db.query<BotInvocationRow>(sql`UPDATE bot_invocations SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId} AND status = 'claimed' AND claimed_by_instance_id = ${params.instanceId} AND claim_token = ${params.claimToken} AND claim_expires_at > NOW()
      RETURNING *`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  async failClaim(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId: string
      claimToken: string
      errorMessage: string
    }
  ): Promise<BotInvocation | null> {
    const result =
      await db.query<BotInvocationRow>(sql`UPDATE bot_invocations SET status = 'failed', error_message = ${params.errorMessage}, updated_at = NOW()
      WHERE id = ${params.invocationId} AND workspace_id = ${params.workspaceId} AND actor_type = 'bot' AND actor_id = ${params.botId} AND status = 'claimed' AND claimed_by_instance_id = ${params.instanceId} AND claim_token = ${params.claimToken} AND claim_expires_at > NOW()
      RETURNING *`)
    return result.rows[0] ? mapInvocation(result.rows[0]) : null
  },

  /**
   * Snapshot for `/bot` namespace bootstrap. Returns two disjoint lists:
   *  - `available`: rows this runtime could claim right now (pending, or
   *    `claimed` with an expired claim) filtered to its capabilities and the
   *    steering target. Used to replay anything that piled up while the
   *    socket was offline.
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
    }
  ): Promise<{ available: BotInvocation[]; ownedClaims: BotInvocation[] }> {
    const [availableResult, ownedClaimsResult] = await Promise.all([
      db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND required_capability = ANY(${params.supportedCapabilities})
          AND (target_instance_id IS NULL OR target_instance_id = ${params.instanceId})
          AND (target_runtime_session_id IS NULL OR target_runtime_session_id = ${params.runtimeSessionId})
          AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at < NOW()))
          AND (${params.since}::timestamptz IS NULL OR created_at >= ${params.since})
        ORDER BY created_at ASC, id ASC
        LIMIT 200`),
      db.query<BotInvocationRow>(sql`SELECT * FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND status = 'claimed'
          AND claimed_by_instance_id = ${params.instanceId}
          AND claim_expires_at > NOW()
        ORDER BY created_at ASC, id ASC
        LIMIT 200`),
    ])
    return {
      available: availableResult.rows.map(mapInvocation),
      ownedClaims: ownedClaimsResult.rows.map(mapInvocation),
    }
  },
}
