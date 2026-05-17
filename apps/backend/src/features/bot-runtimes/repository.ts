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
}

export const BotRuntimeInstanceRepository = {
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
    }
  ): Promise<BotRuntimeInstance> {
    const result =
      await db.query<BotRuntimeInstanceRow>(sql`INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, runtime_kind, instance_id, display_name, status, accepting_invocations, capabilities, status_text)
      VALUES (${params.id}, ${params.workspaceId}, ${params.botId}, ${params.runtimeKind}, ${params.instanceId}, ${params.displayName ?? null}, ${params.status}, ${params.acceptingInvocations}, ${params.capabilities}, ${params.statusText ?? null})
      ON CONFLICT (workspace_id, bot_id, instance_id) DO UPDATE SET runtime_kind = EXCLUDED.runtime_kind, display_name = EXCLUDED.display_name, status = EXCLUDED.status, accepting_invocations = EXCLUDED.accepting_invocations, capabilities = EXCLUDED.capabilities, status_text = EXCLUDED.status_text, last_seen_at = NOW(), updated_at = NOW()
      RETURNING *`)
    return mapRuntimeInstance(result.rows[0]!)
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
  ): Promise<BotInvocation> {
    const result =
      await db.query<BotInvocationRow>(sql`INSERT INTO bot_invocations (id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id, actor_type, actor_id, trigger, required_capability, prompt_markdown, author_user_id, mentioned_actor_slugs, target_instance_id, target_runtime_session_id, metadata)
      VALUES (${params.id}, ${params.workspaceId}, ${params.rootStreamId}, ${params.activeStreamId}, ${params.sourceMessageId}, ${params.responseStreamId}, ${params.actorType}, ${params.actorId}, ${params.trigger}, ${params.requiredCapability}, ${params.promptMarkdown}, ${params.authorUserId}, ${params.mentionedActorSlugs}, ${params.targetInstanceId}, ${params.targetRuntimeSessionId}, ${params.metadata})
      ON CONFLICT (workspace_id, source_message_id, actor_type, actor_id, trigger) DO UPDATE SET updated_at = bot_invocations.updated_at
      RETURNING *`)
    return mapInvocation(result.rows[0]!)
  },

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
    const result = await db.query<BotInvocationRow>(sql`WITH candidate AS (
        SELECT id FROM bot_invocations
        WHERE workspace_id = ${params.workspaceId}
          AND actor_type = 'bot'
          AND actor_id = ${params.botId}
          AND required_capability = ANY(${params.supportedCapabilities})
          AND (target_instance_id IS NULL OR target_instance_id = ${params.instanceId})
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
}
