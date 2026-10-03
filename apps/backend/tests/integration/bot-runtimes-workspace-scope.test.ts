import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { setupTestDatabase, withTransaction } from "./setup"
import {
  BotInvocationRepository,
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
} from "../../src/features/bot-runtimes"
import { botInvocationActorSourceLockKey } from "../../src/features/bot-runtimes/repository"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { BotApiKeyRepository, BotRepository, CURRENT_API_VERSION } from "../../src/features/public-api"
import { SandboxSessionTokenRepository } from "../../src/features/sandboxes/session-token-repository"
import { UserApiKeyRepository } from "../../src/features/user-api-keys"
import {
  botApiKeyId,
  botChannelAccessId,
  botId,
  botInvocationId,
  botRuntimeInstanceId,
  botRuntimeSessionLinkId,
  messageId,
  sandboxSessionTokenId,
  streamActiveActorId,
  streamE2eKeyWrapId,
  streamId,
  userApiKeyId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const RUNTIME_KIND = "claude-code-channel" as const
const WRITTEN_TABLES = [
  "bot_invocations",
  "agent_sessions",
  "messages",
  "streams",
  "bot_runtime_session_links",
  "bot_runtime_instances",
  "bot_channel_access",
  "bots",
  "bot_api_keys",
  "user_api_keys",
  "runtime_e2e_key_holders",
  "runtime_e2e_keys",
  "stream_e2e_key_wraps",
  "e2e_streams",
  "stream_active_actors",
  "sandbox_session_tokens",
  "stream_members",
  "users",
]
const API_KEYS = {
  bot: { table: "bot_api_keys", ownerColumn: "bot_id", newId: botApiKeyId, newOwner: botId },
  user: { table: "user_api_keys", ownerColumn: "user_id", newId: userApiKeyId, newOwner: userId },
} as const

type ApiKeyKind = keyof typeof API_KEYS

interface InvocationSeed {
  sourceMessageId: string
  workspaceId?: string
  streamId?: string
  botId?: string
  status?: string
  cancellationReason?: string
  sourceMessageRevision?: number
  trigger?: string
  targetRuntimeSessionId?: string
  createdAt?: Date
  claimedByInstanceId?: string
  claimToken?: string
  claimed?: { revision: number; expired?: boolean; attempts?: number }
}

interface ApiKeyManagement {
  find?: (ws: string, owner: string, key: string) => Promise<{ id: string } | null>
  list: (ws: string, owner: string) => Promise<{ id: string }[]>
  updateScopes: (ws: string, owner: string, key: string) => Promise<{ id: string } | null>
  updateVersion: (ws: string, owner: string, key: string) => Promise<{ id: string } | null>
  revoke: (ws: string, owner: string, key: string) => Promise<string>
  revokeAll: (ws: string, owner: string) => Promise<number>
}

describe("Bot runtime workspace scope (INV-8)", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let author: string
  let nextSequence = 1
  const tag = Math.random().toString(36).slice(2, 10)

  async function insertStream(ws: string, opts: { archived?: boolean; visibility?: string } = {}) {
    const id = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, created_by, archived_at, visibility) VALUES ($1, $2, 'scratchpad', $3, $4, $5)`,
      [id, ws, author, opts.archived ? new Date() : null, opts.visibility ?? "private"]
    )
    return id
  }

  async function insertMessage(ws: string, stream: string, opts: { revision?: number; keyGeneration?: number } = {}) {
    const id = messageId()
    const sealed = opts.keyGeneration !== undefined
    await pool.query(
      `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, revision, ciphertext, envelope)
       VALUES ($1, $2, $3, $4, $5, 'user', 'x', '{}', $6, $7, $8)`,
      [
        id,
        ws,
        stream,
        nextSequence++,
        author,
        opts.revision ?? 1,
        sealed ? Buffer.from([2]) : null,
        sealed ? JSON.stringify({ v: 2, keyGeneration: opts.keyGeneration }) : null,
      ]
    )
    return id
  }

  /** Inserts a fresh invocation, by default in the owning workspace on a fresh stream. */
  async function insertInvocation(seed: InvocationSeed) {
    const id = botInvocationId()
    const claimed = seed.claimed
    const expiry = claimed ? new Date(Date.now() + (claimed.expired ? -3_600_000 : 3_600_000)) : null
    await pool.query(
      `INSERT INTO bot_invocations (
         id, workspace_id, root_stream_id, active_stream_id, source_message_id, response_stream_id, actor_type, actor_id,
         trigger, required_capability, prompt_markdown, author_user_id, status, claim_token, claim_expires_at, attempts,
         claimed_source_message_revision, cancellation_reason, source_message_revision, claimed_by_instance_id,
         target_runtime_session_id, created_at
       ) VALUES ($1, $2, $3, $3, $4, $3, 'bot', $5, $15, 'active-scratchpad', 'prompt', $6, $7, $8, $9, $10, $11, $12, $13, $14, $16, COALESCE($17::timestamptz, NOW()))`,
      [
        id,
        seed.workspaceId ?? wsA,
        seed.streamId ?? streamId(),
        seed.sourceMessageId,
        seed.botId ?? "bot_scope_default",
        author,
        claimed ? "claimed" : (seed.status ?? "pending"),
        seed.claimToken ?? (claimed ? `tok_${id}` : null),
        expiry,
        claimed?.attempts ?? 0,
        claimed?.revision ?? null,
        seed.cancellationReason ?? null,
        seed.sourceMessageRevision ?? 0,
        seed.claimedByInstanceId ?? (claimed ? "inst_scope" : null),
        seed.trigger ?? "active-scratchpad",
        seed.targetRuntimeSessionId ?? null,
        seed.createdAt ?? null,
      ]
    )
    return id
  }

  async function insertSession(id: string, ws: string) {
    await pool.query(
      `INSERT INTO agent_sessions (id, stream_id, persona_id, trigger_message_id, status, workspace_id)
       VALUES ($1, $2, 'persona_scope', 'msg_scope_trigger', 'running', $3)`,
      [id, streamId(), ws]
    )
  }

  async function insertBot(
    ws: string,
    opts: { owner?: string; readsAsOwner?: boolean; apiKeyId?: string; archived?: boolean } = {}
  ) {
    const id = botId()
    await pool.query(
      `INSERT INTO bots (id, workspace_id, name, slug, type, owner_user_id, reads_as_owner, api_key_id, archived_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        ws,
        `bot-${id}`,
        opts.owner ? "personal" : "shared",
        opts.owner ?? null,
        opts.readsAsOwner ?? false,
        opts.apiKeyId ?? null,
        opts.archived ? new Date() : null,
      ]
    )
    return id
  }

  async function insertUser(ws: string) {
    const id = userId()
    await pool.query(`INSERT INTO users (id, workspace_id, slug) VALUES ($1, $2, $3)`, [id, ws, `user-${id}`])
    return id
  }

  async function insertLink(params: {
    ws: string
    bot: string
    session: string
    stream: string
    status: string
    instanceId: string
  }) {
    const id = botRuntimeSessionLinkId()
    await pool.query(
      `INSERT INTO bot_runtime_session_links (id, workspace_id, bot_id, runtime_kind, instance_id, runtime_session_id, root_stream_id, active_stream_id, status, linked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9)`,
      [id, params.ws, params.bot, RUNTIME_KIND, params.instanceId, params.session, params.stream, params.status, author]
    )
    return id
  }

  async function insertGrant(ws: string, bot: string, stream: string) {
    await pool.query(
      `INSERT INTO bot_channel_access (id, workspace_id, bot_id, stream_id, granted_by) VALUES ($1, $2, $3, $4, $5)`,
      [botChannelAccessId(), ws, bot, stream, author]
    )
  }

  async function invocationStatuses(ids: string[]) {
    const result = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM bot_invocations WHERE id = ANY($1) ORDER BY id`,
      [ids]
    )
    return Object.fromEntries(result.rows.map((row) => [row.id, row.status]))
  }

  async function isShareLocked(message: string) {
    const result = await pool.query(`SELECT id FROM messages WHERE id = $1 FOR UPDATE SKIP LOCKED`, [message])
    return result.rows.length === 0
  }

  const idOf = (row: { id: string } | null) => row?.id ?? null
  const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id).sort()
  const keysOf = (map: Map<string, unknown>) => [...map.keys()].sort()

  /** The same call through the other workspace first, then through the owning one as the control. */
  async function reachedThrough<T>(call: (ws: string) => Promise<T>) {
    const other = await call(wsB)
    const own = await call(wsA)
    return { other, own }
  }

  async function isAdvisoryLocked(key: string) {
    const result = await pool.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired`,
      [key]
    )
    return !result.rows[0]!.acquired
  }

  /** The call's result and whether `key` is still held by its transaction, once through each workspace. */
  function lockedThrough<T>(key: string, call: (client: PoolClient, ws: string) => Promise<T>) {
    return reachedThrough((ws) =>
      withTransaction(pool, async (client) => {
        const result = await call(client, ws)
        return { result, lockHeld: await isAdvisoryLocked(key) }
      })
    )
  }

  async function invocationStates(ids: string[]) {
    const result = await pool.query<{
      id: string
      status: string
      prompt_markdown: string
      source_message_revision: number
      claimed_source_message_revision: number | null
      cancellation_reason: string | null
      lease_extended: boolean
    }>(
      `SELECT id, status, prompt_markdown, source_message_revision, claimed_source_message_revision, cancellation_reason,
              COALESCE(claim_expires_at > NOW() + INTERVAL '90 minutes', FALSE) AS lease_extended
       FROM bot_invocations WHERE id = ANY($1) ORDER BY id`,
      [ids]
    )
    return Object.fromEntries(
      result.rows.map((row) => [
        row.id,
        {
          status: row.status,
          promptMarkdown: row.prompt_markdown,
          sourceRevision: row.source_message_revision,
          claimedRevision: row.claimed_source_message_revision,
          cancellationReason: row.cancellation_reason,
          leaseExtended: row.lease_extended,
        },
      ])
    )
  }

  async function linkStates(ids: string[]) {
    const result = await pool.query<{ id: string; status: string; instance_id: string; reply_mode: string }>(
      `SELECT id, status, instance_id, reply_mode FROM bot_runtime_session_links WHERE id = ANY($1) ORDER BY id`,
      [ids]
    )
    return Object.fromEntries(
      result.rows.map((row) => [row.id, { status: row.status, instanceId: row.instance_id, replyMode: row.reply_mode }])
    )
  }

  async function insertInstance(
    ws: string,
    bot: string,
    instanceId: string,
    opts: { manifest?: Record<string, unknown> } = {}
  ) {
    const id = botRuntimeInstanceId()
    await pool.query(
      `INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, runtime_kind, instance_id, status, accepting_invocations, manifest)
       VALUES ($1, $2, $3, $4, $5, 'available', TRUE, $6)`,
      [id, ws, bot, RUNTIME_KIND, instanceId, opts.manifest ? JSON.stringify(opts.manifest) : null]
    )
    return id
  }

  async function sealStream(stream: string, ws: string) {
    await pool.query(
      `INSERT INTO e2e_streams (stream_id, workspace_id, owner_user_id, owner_user_key_id, current_key_generation)
       VALUES ($1, $2, $3, 'e2ek_owner', 2)`,
      [stream, ws, author]
    )
  }

  async function insertRuntimeKey(ws: string, keyId: string) {
    await pool.query(`INSERT INTO runtime_e2e_keys (workspace_id, key_id, public_key) VALUES ($1, $2, 'cHVibGlj')`, [
      ws,
      keyId,
    ])
  }

  async function insertKeyHolder(ws: string, keyId: string, bot: string, instanceId: string) {
    await pool.query(
      `INSERT INTO runtime_e2e_key_holders (workspace_id, key_id, bot_id, instance_id) VALUES ($1, $2, $3, $4)`,
      [ws, keyId, bot, instanceId]
    )
  }

  async function insertWrap(ws: string, stream: string, generation: number, keyId: string) {
    await pool.query(
      `INSERT INTO stream_e2e_key_wraps (id, workspace_id, stream_id, key_generation, recipient_key_id, recipient_kind, wrap_enc, wrap_ct)
       VALUES ($1, $2, $3, $4, $5, 'bot', '\\x00', '\\x01')`,
      [streamE2eKeyWrapId(), ws, stream, generation, keyId]
    )
  }

  async function insertApiKey(kind: ApiKeyKind, ws: string, owner: string) {
    const { table, ownerColumn, newId } = API_KEYS[kind]
    const id = newId()
    await pool.query(
      `INSERT INTO ${table} (id, workspace_id, ${ownerColumn}, name, key_hash, key_prefix, scopes, api_version)
       VALUES ($1, $2, $3, 'key', $4, 'abcdefgh', ARRAY['messages:read'], NULL)`,
      [id, ws, owner, `hash_${id}`]
    )
    return id
  }

  async function apiKeyRows(kind: ApiKeyKind, ids: string[]) {
    const result = await pool.query<{
      id: string
      scopes: string[]
      api_version: string | null
      revoked: boolean
      used: boolean
    }>(
      `SELECT id, scopes, api_version, revoked_at IS NOT NULL AS revoked, last_used_at IS NOT NULL AS used
       FROM ${API_KEYS[kind].table} WHERE id = ANY($1)`,
      [ids]
    )
    return result.rows
  }

  const claimParams = (bot: string, instanceId: string) => ({
    workspaceId: wsA,
    botId: bot,
    instanceId,
    runtimeKind: RUNTIME_KIND,
    supportedCapabilities: ["active-scratchpad" as const],
    maxAttempts: 5,
  })

  const claimNext = (bot: string, instanceId: string, claimToken: string) =>
    BotInvocationRepository.claimOne(pool, { ...claimParams(bot, instanceId), claimToken, claimTtlSeconds: 60 })

  const bootstrapInvocations = (bot: string, instanceId: string) =>
    BotInvocationRepository.findBootstrapInvocations(pool, {
      workspaceId: wsA,
      botId: bot,
      instanceId,
      runtimeSessionId: null,
      supportedCapabilities: ["active-scratchpad"],
      since: null,
      maxAttempts: 5,
    })

  async function cancelBySource(db: Pool | PoolClient, ws: string, source: string) {
    const result = await BotInvocationRepository.cancelActiveBySource(db, {
      workspaceId: ws,
      sourceMessageId: source,
      reason: "source_deleted",
    })
    return { transitioned: idsOf(result.transitioned), sessionRepairCandidates: idsOf(result.sessionRepairCandidates) }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = workspaceId()
    wsB = workspaceId()
    author = userId()
  })

  afterAll(async () => {
    for (const table of WRITTEN_TABLES) {
      await pool.query(`DELETE FROM ${table} WHERE workspace_id = ANY($1)`, [[wsA, wsB]])
    }
    await pool.end()
  })

  /**
   * One invocation per way the canonical source join can cross workspaces: the
   * source message belongs to the other workspace but sits under this
   * workspace's stream, the message is this workspace's but its stream belongs
   * to the other, and an own-workspace control that must pass.
   */
  async function seedCanonicalCases(bot: string, claim: { expired: boolean; attempts: number }) {
    const claimed = { revision: 1, ...claim }
    const seedCase = async (streamIn: string, messageIn: string) => {
      const stream = await insertStream(streamIn)
      const message = await insertMessage(messageIn, stream)
      const invocation = await insertInvocation({ streamId: stream, sourceMessageId: message, botId: bot, claimed })
      return { messageId: message, invocationId: invocation }
    }

    return {
      foreignMessage: await seedCase(wsA, wsB),
      foreignStream: await seedCase(wsB, wsA),
      own: await seedCase(wsA, wsA),
    }
  }

  describe("claim close-out through the canonical source join", () => {
    type CanonicalCases = Awaited<ReturnType<typeof seedCanonicalCases>>

    async function closeOutAcrossCases(
      close: (client: PoolClient, bot: string, invocationId: string) => Promise<{ status: string } | null>
    ) {
      const bot = botId()
      const cases = await seedCanonicalCases(bot, { expired: false, attempts: 1 })

      const closeOut = (c: { invocationId: string; messageId: string }) =>
        withTransaction(pool, async (client) => {
          const closed = await close(client, bot, c.invocationId)
          return { status: closed?.status ?? null, messageLocked: await isShareLocked(c.messageId) }
        })

      const results = {
        foreignMessage: await closeOut(cases.foreignMessage),
        foreignStream: await closeOut(cases.foreignStream),
        own: await closeOut(cases.own),
      }
      const stored = await invocationStatuses([
        cases.foreignMessage.invocationId,
        cases.foreignStream.invocationId,
        cases.own.invocationId,
      ])

      return { cases, closed: { results, stored } }
    }

    const closedOnlyForOwn = (cases: CanonicalCases, status: string) => ({
      results: {
        foreignMessage: { status: null, messageLocked: false },
        foreignStream: { status: null, messageLocked: false },
        own: { status, messageLocked: true },
      },
      stored: {
        [cases.foreignMessage.invocationId]: "claimed",
        [cases.foreignStream.invocationId]: "claimed",
        [cases.own.invocationId]: status,
      },
    })

    test("should leave a message from another workspace unlocked and the claim open when completing a claim", async () => {
      const { cases, closed } = await closeOutAcrossCases((client, bot, invocationId) =>
        BotInvocationRepository.completeClaim(client, {
          workspaceId: wsA,
          botId: bot,
          invocationId,
          claimToken: `tok_${invocationId}`,
          sourceRevision: 1,
        })
      )

      expect(closed).toEqual(closedOnlyForOwn(cases, "completed"))
    })

    test("should leave a message from another workspace unlocked and the claim open when failing a claim", async () => {
      const { cases, closed } = await closeOutAcrossCases((client, bot, invocationId) =>
        BotInvocationRepository.failClaim(client, {
          workspaceId: wsA,
          botId: bot,
          invocationId,
          claimToken: `tok_${invocationId}`,
          errorMessage: "boom",
        })
      )

      expect(closed).toEqual(closedOnlyForOwn(cases, "failed"))
    })

    test("should park only the invocation whose source lives in its own workspace when parking exhausted claims", async () => {
      const bot = botId()
      const cases = await seedCanonicalCases(bot, { expired: true, attempts: 5 })

      const outcome = await withTransaction(pool, async (client) => {
        const parked = await BotInvocationRepository.parkExhausted(client, {
          workspaceId: wsA,
          botId: bot,
          maxAttempts: 5,
        })
        return {
          parkedIds: idsOf(parked),
          locked: {
            foreignMessage: await isShareLocked(cases.foreignMessage.messageId),
            foreignStream: await isShareLocked(cases.foreignStream.messageId),
            own: await isShareLocked(cases.own.messageId),
          },
        }
      })

      expect({
        outcome,
        stored: await invocationStatuses([
          cases.foreignMessage.invocationId,
          cases.foreignStream.invocationId,
          cases.own.invocationId,
        ]),
      }).toEqual({
        outcome: {
          parkedIds: [cases.own.invocationId],
          locked: { foreignMessage: false, foreignStream: false, own: true },
        },
        stored: {
          [cases.foreignMessage.invocationId]: "claimed",
          [cases.foreignStream.invocationId]: "claimed",
          [cases.own.invocationId]: "parked",
        },
      })
    })
  })

  describe("sealed-stream claim gate", () => {
    test("should leave an invocation unclaimable when its source message belongs to another workspace", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}`
      const keyId = `rek_${tag}`
      const sealed = await insertStream(wsA)
      await sealStream(sealed, wsA)
      await insertRuntimeKey(wsA, keyId)
      await insertKeyHolder(wsA, keyId, bot, instanceId)
      await insertWrap(wsA, sealed, 2, keyId)
      await insertInstance(wsA, bot, instanceId)

      const foreignSource = await insertMessage(wsB, sealed, { keyGeneration: 2 })
      const decoy = await insertInvocation({ streamId: sealed, sourceMessageId: foreignSource, botId: bot })
      const ownSource = await insertMessage(wsA, sealed, { keyGeneration: 2 })
      const control = await insertInvocation({ streamId: sealed, sourceMessageId: ownSource, botId: bot })

      const nextClaimable = await BotInvocationRepository.findNextClaimable(pool, claimParams(bot, instanceId))
      const first = await claimNext(bot, instanceId, "tok_first")
      const second = await claimNext(bot, instanceId, "tok_second")

      expect({
        nextClaimable: idOf(nextClaimable),
        first: idOf(first),
        second: idOf(second),
        stored: await invocationStatuses([decoy, control]),
      }).toEqual({
        nextClaimable: control,
        first: control,
        second: null,
        stored: { [decoy]: "pending", [control]: "claimed" },
      })
    })
  })

  describe("cancelActiveBySource", () => {
    test("should take the revision only from a source message in the invocation's own workspace and stream when cancelling", async () => {
      const bot = botId()
      const streamInA = await insertStream(wsA)
      const streamInB = await insertStream(wsB)
      const invocationOn = (ws: string, stream: string, source: string) =>
        insertInvocation({
          workspaceId: ws,
          streamId: stream,
          sourceMessageId: source,
          botId: bot,
          sourceMessageRevision: 1,
        })

      const foreignMessage = await insertMessage(wsB, streamInA, { revision: 9 })
      const foreignMessageInvocation = await invocationOn(wsA, streamInA, foreignMessage)
      const foreignStreamMessage = await insertMessage(wsA, streamInB, { revision: 9 })
      const foreignStreamInvocation = await invocationOn(wsA, streamInB, foreignStreamMessage)
      const ownMessage = await insertMessage(wsA, streamInA, { revision: 4 })
      const ownInvocation = await invocationOn(wsA, streamInA, ownMessage)
      const otherWorkspaceInvocation = await invocationOn(wsB, streamInB, ownMessage)

      const transitioned: string[][] = []
      for (const source of [foreignMessage, foreignStreamMessage, ownMessage]) {
        transitioned.push((await cancelBySource(pool, wsA, source)).transitioned)
      }
      const stored = await pool.query<{ id: string; status: string; source_message_revision: number }>(
        `SELECT id, status, source_message_revision FROM bot_invocations WHERE id = ANY($1) ORDER BY id`,
        [[foreignMessageInvocation, foreignStreamInvocation, ownInvocation, otherWorkspaceInvocation]]
      )

      expect({
        transitioned,
        stored: Object.fromEntries(stored.rows.map((r) => [r.id, [r.status, r.source_message_revision]])),
      }).toEqual({
        transitioned: [[foreignMessageInvocation], [foreignStreamInvocation], [ownInvocation]],
        stored: {
          [foreignMessageInvocation]: ["cancelled", 1],
          [foreignStreamInvocation]: ["cancelled", 1],
          [ownInvocation]: ["cancelled", 4],
          [otherWorkspaceInvocation]: ["pending", 1],
        },
      })
    })

    test("should list as repair candidates only completed invocations whose session is in the same workspace when cancelling", async () => {
      const bot = botId()
      const stream = await insertStream(wsA)
      const source = await insertMessage(wsA, stream)
      const completedOn = (sessionWorkspace: string) =>
        insertInvocation({ streamId: stream, sourceMessageId: source, botId: bot, status: "completed" }).then(
          async (id) => {
            await insertSession(id, sessionWorkspace)
            return id
          }
        )
      await completedOn(wsB)
      const ownSession = await completedOn(wsA)

      const cancelled = await reachedThrough((ws) => cancelBySource(pool, ws, source))

      expect(cancelled).toEqual({
        other: { transitioned: [], sessionRepairCandidates: [] },
        own: { transitioned: [], sessionRepairCandidates: [ownSession] },
      })
    })
  })

  describe("deleted-source session repair lookups", () => {
    const sources = { first: `${tag}_s0`, second: `${tag}_s2`, cross: `${tag}_s1`, other: `${tag}_b1` }
    let own: string
    let crossSession: string
    let otherWorkspaceInvocation: string

    const lookup = (ws: string, session: string) =>
      BotInvocationRepository.findDeletedSourceForRunningSession(pool, { workspaceId: ws, sessionId: session })

    beforeAll(async () => {
      const stream = await insertStream(wsA)
      const streamInB = await insertStream(wsB)
      const seed = async (ws: string, source: string, sessionWorkspace: string, stream: string) => {
        const id = await insertInvocation({
          workspaceId: ws,
          streamId: stream,
          sourceMessageId: source,
          botId: botId(),
          status: "cancelled",
          cancellationReason: "source_deleted",
        })
        await insertSession(id, sessionWorkspace)
        return id
      }
      await seed(wsA, sources.first, wsA, stream)
      own = await seed(wsA, sources.second, wsA, stream)
      crossSession = await seed(wsA, sources.cross, wsB, stream)
      otherWorkspaceInvocation = await seed(wsB, sources.other, wsB, streamInB)
    })

    test("should find the source only for the invocation's own workspace and session when looking up one running session", async () => {
      expect({
        own: await lookup(wsA, own),
        sessionInOtherWorkspace: await lookup(wsA, crossSession),
        askedThroughOtherWorkspace: await lookup(wsB, own),
        otherWorkspaceOwn: await lookup(wsB, otherWorkspaceInvocation),
      }).toEqual({
        own: { workspaceId: wsA, sourceMessageId: sources.second },
        sessionInOtherWorkspace: null,
        askedThroughOtherWorkspace: null,
        otherWorkspaceOwn: { workspaceId: wsB, sourceMessageId: sources.other },
      })
    })

    test("should skip an invocation whose session belongs to another workspace when sweeping every workspace", async () => {
      const swept = await BotInvocationRepository.findDeletedSourcesWithRunningSessions(pool, 100_000)

      expect(
        swept
          .filter((row) => row.workspaceId === wsA || row.workspaceId === wsB)
          .map((row) => `${row.workspaceId}:${row.sourceMessageId}`)
          .sort()
      ).toEqual([`${wsA}:${sources.first}`, `${wsA}:${sources.second}`, `${wsB}:${sources.other}`].sort())
    })
  })

  describe("runtime session link re-activation and retirement", () => {
    /** An archived link on an own stream, one on the other workspace's stream, and a link in the other workspace reusing the first's session id. */
    async function seedArchivedLinks(suffix: string, streamsArchived: boolean) {
      const bot = botId()
      const instanceId = `inst_${tag}_${suffix}`
      const session = `rs_${tag}_${suffix}`
      const crossStreamSession = `${session}_cross`
      const archivedLink = async (ws: string, runtimeSession: string, streamIn: string) =>
        insertLink({
          ws,
          bot,
          session: runtimeSession,
          stream: await insertStream(streamIn, { archived: streamsArchived }),
          status: "archived",
          instanceId,
        })

      return {
        base: { workspaceId: wsA, botId: bot, runtimeKind: RUNTIME_KIND, instanceId },
        session,
        crossStreamSession,
        ownLink: await archivedLink(wsA, session, wsA),
        crossStreamLink: await archivedLink(wsA, crossStreamSession, wsB),
        otherWorkspaceLink: await archivedLink(wsB, session, wsB),
      }
    }

    test("should reactivate only the link whose stream is in its own workspace when re-activating an archived session", async () => {
      const links = await seedArchivedLinks("r", false)

      const reactivated = await BotRuntimeSessionLinkRepository.reactivateArchivedByRuntimeSession(pool, {
        ...links.base,
        runtimeSessionId: links.session,
      })
      const crossStream = await BotRuntimeSessionLinkRepository.reactivateArchivedByRuntimeSession(pool, {
        ...links.base,
        runtimeSessionId: links.crossStreamSession,
      })
      const stored = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM bot_runtime_session_links WHERE id = ANY($1)`,
        [[links.ownLink, links.crossStreamLink, links.otherWorkspaceLink]]
      )

      expect({
        reactivated: idOf(reactivated),
        crossStream: idOf(crossStream),
        stored: Object.fromEntries(stored.rows.map((row) => [row.id, row.status])),
      }).toEqual({
        reactivated: links.ownLink,
        crossStream: null,
        stored: {
          [links.ownLink]: "active",
          [links.crossStreamLink]: "archived",
          [links.otherWorkspaceLink]: "archived",
        },
      })
    })

    test("should retire only the link whose archived stream is in its own workspace when replacing an archived session", async () => {
      const links = await seedArchivedLinks("t", true)

      const retired = await BotRuntimeSessionLinkRepository.retireArchivedByRuntimeSession(pool, {
        ...links.base,
        runtimeSessionId: links.session,
      })
      const crossStream = await BotRuntimeSessionLinkRepository.retireArchivedByRuntimeSession(pool, {
        ...links.base,
        runtimeSessionId: links.crossStreamSession,
      })
      const stored = await pool.query<{ id: string; status: string; runtime_session_id: string }>(
        `SELECT id, status, runtime_session_id FROM bot_runtime_session_links WHERE id = ANY($1)`,
        [[links.ownLink, links.crossStreamLink, links.otherWorkspaceLink]]
      )

      expect({
        retired: idOf(retired),
        crossStream: idOf(crossStream),
        stored: Object.fromEntries(stored.rows.map((row) => [row.id, [row.status, row.runtime_session_id]])),
      }).toEqual({
        retired: links.ownLink,
        crossStream: null,
        stored: {
          [links.ownLink]: ["ended", `${links.session}:retired:${links.ownLink}`],
          [links.crossStreamLink]: ["archived", links.crossStreamSession],
          [links.otherWorkspaceLink]: ["archived", links.session],
        },
      })
    })
  })

  describe("bot channel grants", () => {
    test("should list only grants whose stream and bot are in the same workspace when reading a bot's channel access", async () => {
      const bot = await insertBot(wsA)
      const foreignBot = await insertBot(wsB)
      const ownStream = await insertStream(wsA)
      const streamInB = await insertStream(wsB)
      await insertGrant(wsA, bot, ownStream)
      await insertGrant(wsA, bot, streamInB)
      await insertGrant(wsA, foreignBot, ownStream)
      await insertGrant(wsB, bot, streamInB)

      expect({
        grantedStreamIds: await BotChannelAccessRepository.getGrantedStreamIds(pool, wsA, bot),
        grants: (await BotChannelAccessRepository.listGrants(pool, wsA, bot)).map((grant) => grant.streamId),
        grantedBotIds: await BotChannelAccessRepository.getGrantedBotIds(pool, wsA, ownStream),
      }).toEqual({
        grantedStreamIds: [ownStream],
        grants: [ownStream],
        grantedBotIds: [bot],
      })
    })
  })

  describe("API key last-used stamps", () => {
    async function stampedThrough(kind: ApiKeyKind, touch: (ws: string, id: string) => Promise<void>) {
      const owner = API_KEYS[kind].newOwner()
      const keys = {
        own: await insertApiKey(kind, wsA, owner),
        neighbour: await insertApiKey(kind, wsA, owner),
        otherWorkspace: await insertApiKey(kind, wsB, owner),
      }
      const stamped = async () => {
        const used = Object.fromEntries((await apiKeyRows(kind, Object.values(keys))).map((row) => [row.id, row.used]))
        return { own: used[keys.own], neighbour: used[keys.neighbour], otherWorkspace: used[keys.otherWorkspace] }
      }

      await touch(wsB, keys.own)
      const afterForeignWorkspace = await stamped()
      await touch(wsA, keys.own)

      return { afterForeignWorkspace, afterOwnWorkspace: await stamped() }
    }

    const onlyOwnKeyStamped = {
      afterForeignWorkspace: { own: false, neighbour: false, otherWorkspace: false },
      afterOwnWorkspace: { own: true, neighbour: false, otherWorkspace: false },
    }

    test("should stamp only the key in the given workspace when touching a bot API key", async () => {
      const stamps = await stampedThrough("bot", (ws, id) => BotApiKeyRepository.touchLastUsed(pool, ws, id))

      expect(stamps).toEqual(onlyOwnKeyStamped)
    })

    test("should stamp only the key in the given workspace when touching a user API key", async () => {
      const stamps = await stampedThrough("user", (ws, id) => UserApiKeyRepository.touchLastUsed(pool, ws, id))

      expect(stamps).toEqual(onlyOwnKeyStamped)
    })
  })

  describe("bot visibility", () => {
    test("should not list or find a shared bot from another workspace when reading the bots visible to a user", async () => {
      const own = await insertBot(wsA)
      const foreign = await insertBot(wsB)
      const viewer = userId()

      const visible = await BotRepository.listVisibleTo(pool, wsA, viewer)

      expect({
        listed: visible.map((bot) => bot.id).filter((id) => id === own || id === foreign),
        foundOwn: idOf(await BotRepository.findVisibleTo(pool, wsA, viewer, own)),
        foundForeign: idOf(await BotRepository.findVisibleTo(pool, wsA, viewer, foreign)),
      }).toEqual({ listed: [own], foundOwn: own, foundForeign: null })
    })
  })

  describe("runtime presence", () => {
    test("should find an active actor and an instance only through the workspace that holds them when reading bot presence", async () => {
      const bot = botId()
      const root = await insertStream(wsA)
      await pool.query(
        `INSERT INTO stream_active_actors (id, workspace_id, root_stream_id, actor_type, actor_id, created_by)
         VALUES ($1, $2, $3, 'bot', $4, $5)`,
        [streamActiveActorId(), wsA, root, bot, author]
      )
      const instanceId = `inst_${tag}_pr`
      const instanceRow = await insertInstance(wsA, bot, instanceId)

      const seen = await reachedThrough(async (ws) => ({
        activeActor: (await StreamActiveActorRepository.findByRootStream(pool, ws, root))?.actorId ?? null,
        activeRoots: (await StreamActiveActorRepository.findActiveForBot(pool, { workspaceId: ws, botId: bot })).map(
          (actor) => actor.rootStreamId
        ),
        latest: idOf(await BotRuntimeInstanceRepository.findLatestForBot(pool, ws, bot)),
        byInstance: idOf(
          await BotRuntimeInstanceRepository.findByInstance(pool, { workspaceId: ws, botId: bot, instanceId })
        ),
        latestForBots: keysOf(await BotRuntimeInstanceRepository.findLatestForBots(pool, ws, [bot])),
      }))

      expect(seen).toEqual({
        other: { activeActor: null, activeRoots: [], latest: null, byInstance: null, latestForBots: [] },
        own: {
          activeActor: bot,
          activeRoots: [root],
          latest: instanceRow,
          byInstance: instanceRow,
          latestForBots: [bot],
        },
      })
    })

    test("should mark an instance offline only through its own workspace when its socket grace window expires", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_off`
      await insertInstance(wsA, bot, instanceId)
      const disconnectedAt = new Date(Date.now() + 60_000)

      const status = await reachedThrough(async (ws) => {
        await BotRuntimeInstanceRepository.markOffline(pool, {
          workspaceId: ws,
          botId: bot,
          instanceId,
          disconnectedAt,
        })
        return (await BotRuntimeInstanceRepository.findByInstance(pool, { workspaceId: wsA, botId: bot, instanceId }))
          ?.status
      })

      expect(status).toEqual({ other: "available", own: "offline" })
    })
  })

  describe("runtime session link lookups", () => {
    test("should find a link only through its own workspace when looking it up by stream, session, bot or instance", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_lk`
      const activeSession = `rs_${tag}_lk`
      const archivedSession = `rs_${tag}_lka`
      const activeStream = await insertStream(wsA)
      const archivedStream = await insertStream(wsA)
      const active = await insertLink({
        ws: wsA,
        bot,
        session: activeSession,
        stream: activeStream,
        status: "active",
        instanceId,
      })
      const archived = await insertLink({
        ws: wsA,
        bot,
        session: archivedSession,
        stream: archivedStream,
        status: "archived",
        instanceId,
      })

      const found = await reachedThrough(async (ws) => {
        const session = { workspaceId: ws, botId: bot, instanceId, runtimeSessionId: activeSession }
        const stream = { workspaceId: ws, botId: bot, rootStreamId: activeStream, activeStreamId: activeStream }
        return {
          archivedBySession: idOf(
            await BotRuntimeSessionLinkRepository.findArchivedByRuntimeSession(pool, {
              workspaceId: ws,
              botId: bot,
              runtimeKind: RUNTIME_KIND,
              instanceId,
              runtimeSessionId: archivedSession,
            })
          ),
          activeBySessionForShare: idOf(
            await BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(pool, session)
          ),
          activeByStreamForShareList: idsOf(
            await BotRuntimeSessionLinkRepository.listActiveByStreamForShare(pool, {
              workspaceId: ws,
              rootStreamId: activeStream,
              activeStreamId: activeStream,
            })
          ),
          activeByStream: idOf(await BotRuntimeSessionLinkRepository.findActiveByStream(pool, stream)),
          activeByStreamForShare: idOf(await BotRuntimeSessionLinkRepository.findActiveByStreamForShare(pool, stream)),
          activeBySession: idOf(await BotRuntimeSessionLinkRepository.findActiveByRuntimeSession(pool, session)),
          activeStreams: keysOf(
            await BotRuntimeSessionLinkRepository.findActiveByStreams(pool, {
              workspaceId: ws,
              botId: bot,
              activeStreamIds: [activeStream],
            })
          ),
          activeBots: keysOf(
            await BotRuntimeSessionLinkRepository.findActiveByBotsAndStream(pool, {
              workspaceId: ws,
              botIds: [bot],
              activeStreamId: activeStream,
            })
          ),
          activeByInstance: idsOf(
            await BotRuntimeSessionLinkRepository.findActiveByBotInstance(pool, {
              workspaceId: ws,
              botId: bot,
              instanceId,
            })
          ),
        }
      })

      expect(found).toEqual({
        other: {
          archivedBySession: null,
          activeBySessionForShare: null,
          activeByStreamForShareList: [],
          activeByStream: null,
          activeByStreamForShare: null,
          activeBySession: null,
          activeStreams: [],
          activeBots: [],
          activeByInstance: [],
        },
        own: {
          archivedBySession: archived,
          activeBySessionForShare: active,
          activeByStreamForShareList: [active],
          activeByStream: active,
          activeByStreamForShare: active,
          activeBySession: active,
          activeStreams: [activeStream],
          activeBots: [bot],
          activeByInstance: [active],
        },
      })
    })

    test("should change a link only through its own workspace when archiving, reviving, ending, rebinding or switching it", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_wr`
      const newInstanceId = `inst_${tag}_wr2`
      const seedLink = async (name: string, status: string) => {
        const stream = await insertStream(wsA)
        const session = `rs_${tag}_wr_${name}`
        return { stream, session, id: await insertLink({ ws: wsA, bot, session, stream, status, instanceId }) }
      }
      const toArchive = await seedLink("archive", "active")
      const toRevive = await seedLink("revive", "archived")
      const toEnd = await seedLink("end", "active")
      const toRebind = await seedLink("rebind", "active")
      const toSwitch = await seedLink("switch", "active")

      const changed = await reachedThrough(async (ws) => {
        await BotRuntimeSessionLinkRepository.archiveActiveByStreams(pool, {
          workspaceId: ws,
          streamIds: [toArchive.stream],
        })
        await BotRuntimeSessionLinkRepository.reactivateArchivedByStreams(pool, {
          workspaceId: ws,
          streamIds: [toRevive.stream],
        })
        await BotRuntimeSessionLinkRepository.endActiveByRuntimeSession(pool, {
          workspaceId: ws,
          botId: bot,
          instanceId,
          runtimeSessionId: toEnd.session,
        })
        await BotRuntimeSessionLinkRepository.rebindInstance(pool, {
          workspaceId: ws,
          botId: bot,
          linkId: toRebind.id,
          instanceId,
          runtimeSessionId: toRebind.session,
          newInstanceId,
        })
        await BotRuntimeSessionLinkRepository.setReplyMode(pool, {
          workspaceId: ws,
          linkId: toSwitch.id,
          replyMode: "thread",
        })
        return linkStates([toArchive.id, toRevive.id, toEnd.id, toRebind.id, toSwitch.id])
      })

      const untouched = (status: string) => ({ status, instanceId, replyMode: "flat" })
      expect(changed).toEqual({
        other: {
          [toArchive.id]: untouched("active"),
          [toRevive.id]: untouched("archived"),
          [toEnd.id]: untouched("active"),
          [toRebind.id]: untouched("active"),
          [toSwitch.id]: untouched("active"),
        },
        own: {
          [toArchive.id]: untouched("archived"),
          [toRevive.id]: untouched("active"),
          [toEnd.id]: untouched("ended"),
          [toRebind.id]: { ...untouched("active"), instanceId: newInstanceId },
          [toSwitch.id]: { ...untouched("active"), replyMode: "thread" },
        },
      })
    })
  })

  describe("bot invocation lock identity", () => {
    const actorLockKey = (ws: string, source: string, bot: string) =>
      botInvocationActorSourceLockKey({ workspaceId: ws, sourceMessageId: source, actorType: "bot", actorId: bot })

    test("should hold the source's lock only when the claim is in the given workspace when reading a claim's control state", async () => {
      const bot = botId()
      const source = `${tag}_lc`
      const invocation = await insertInvocation({ sourceMessageId: source, botId: bot, claimed: { revision: 1 } })

      const control = await lockedThrough(actorLockKey(wsA, source, bot), async (client, ws) =>
        idOf(
          await BotInvocationRepository.findClaimControl(client, {
            workspaceId: ws,
            botId: bot,
            invocationId: invocation,
            instanceId: "inst_scope",
            claimToken: `tok_${invocation}`,
          })
        )
      )

      expect(control).toEqual({
        other: { result: null, lockHeld: false },
        own: { result: invocation, lockHeld: true },
      })
    })

    test("should cancel and lock only the given workspace's routes when a source's routing changes", async () => {
      const bot = botId()
      const source = `${tag}_lr`
      const invocation = await insertInvocation({ sourceMessageId: source, botId: bot })

      const cancelled = await lockedThrough(actorLockKey(wsA, source, bot), async (client, ws) =>
        idsOf(
          await BotInvocationRepository.cancelActiveRoutesNotDesired(client, {
            workspaceId: ws,
            sourceMessageId: source,
            sourceMessageRevision: 1,
            desiredRoutes: [],
          })
        )
      )

      expect({ cancelled, stored: await invocationStates([invocation]) }).toEqual({
        cancelled: {
          other: { result: [], lockHeld: false },
          own: { result: [invocation], lockHeld: true },
        },
        stored: {
          [invocation]: {
            status: "cancelled",
            promptMarkdown: "prompt",
            sourceRevision: 1,
            claimedRevision: null,
            cancellationReason: "routing_changed",
            leaseExtended: false,
          },
        },
      })
    })

    test("should cancel and lock only the given workspace's invocations when a source is deleted", async () => {
      const bot = botId()
      const source = `${tag}_ls`
      const invocation = await insertInvocation({ sourceMessageId: source, botId: bot })

      const cancelled = await lockedThrough(actorLockKey(wsA, source, bot), (client, ws) =>
        cancelBySource(client, ws, source)
      )

      expect(cancelled).toEqual({
        other: { result: { transitioned: [], sessionRepairCandidates: [] }, lockHeld: false },
        own: { result: { transitioned: [invocation], sessionRepairCandidates: [] }, lockHeld: true },
      })
    })

    test("should park and lock only the given workspace's exhausted claims when sweeping a bot", async () => {
      const bot = botId()
      const source = `${tag}_lp`
      const invocation = await insertInvocation({
        sourceMessageId: source,
        botId: bot,
        trigger: "session-control",
        claimed: { revision: 0, expired: true, attempts: 5 },
      })

      const parked = await lockedThrough(actorLockKey(wsA, source, bot), async (client, ws) =>
        idsOf(await BotInvocationRepository.parkExhausted(client, { workspaceId: ws, botId: bot, maxAttempts: 5 }))
      )

      expect(parked).toEqual({
        other: { result: [], lockHeld: false },
        own: { result: [invocation], lockHeld: true },
      })
    })
  })

  describe("bot invocation lookups", () => {
    test("should find a claimed or completed invocation only through its own workspace when reading it for a runtime callback", async () => {
      const bot = botId()
      const instanceId = "inst_scope"
      const completedSource = `${tag}_rd2`
      const stream = streamId()
      const claimed = await insertInvocation({
        streamId: stream,
        sourceMessageId: `${tag}_rd1`,
        botId: bot,
        claimed: { revision: 1 },
      })
      const completed = await insertInvocation({
        streamId: stream,
        sourceMessageId: completedSource,
        botId: bot,
        status: "completed",
        claimToken: "tok_done",
        sourceMessageRevision: 3,
      })

      const found = await reachedThrough(async (ws) => {
        const claim = { workspaceId: ws, botId: bot, invocationId: claimed, instanceId, claimToken: `tok_${claimed}` }
        const replay = { workspaceId: ws, botId: bot, invocationId: completed, claimToken: "tok_done" }
        return {
          isSession: await BotInvocationRepository.isBotInvocationSession(pool, ws, claimed),
          liveClaimed: idOf(
            await BotInvocationRepository.findLiveClaimedForBot(pool, {
              workspaceId: ws,
              botId: bot,
              invocationId: claimed,
            })
          ),
          activeClaim: idOf(await BotInvocationRepository.findActiveClaim(pool, claim)),
          forCallback: idOf(await BotInvocationRepository.findForCallback(pool, replay)),
          claimControl: idOf(await BotInvocationRepository.findClaimControl(pool, claim)),
          claimControlWithLocksHeld: idOf(
            await BotInvocationRepository.findClaimControl(pool, claim, { locksHeld: true })
          ),
          activeClaimForUpdate: idOf(await BotInvocationRepository.findActiveClaimForUpdate(pool, claim)),
          completedForReplay: idOf(await BotInvocationRepository.findCompletedForReplay(pool, replay)),
          completedRevisions: Object.fromEntries(
            await BotInvocationRepository.listCompletedTurnRevisionsBySource(pool, {
              workspaceId: ws,
              sourceMessageId: completedSource,
              actorIds: [bot],
            })
          ),
        }
      })

      expect(found).toEqual({
        other: {
          isSession: false,
          liveClaimed: null,
          activeClaim: null,
          forCallback: null,
          claimControl: null,
          claimControlWithLocksHeld: null,
          activeClaimForUpdate: null,
          completedForReplay: null,
          completedRevisions: {},
        },
        own: {
          isSession: true,
          liveClaimed: claimed,
          activeClaim: claimed,
          forCallback: completed,
          claimControl: claimed,
          claimControlWithLocksHeld: claimed,
          activeClaimForUpdate: claimed,
          completedForReplay: completed,
          completedRevisions: { [bot]: 3 },
        },
      })
    })

    test("should change an invocation only through its own workspace when renewing, cancelling or pinning it", async () => {
      const bot = botId()
      const stream = streamId()
      const runtimeSession = `rs_${tag}_w`
      const seed = (name: string, extra: Partial<InvocationSeed>) =>
        insertInvocation({ streamId: stream, sourceMessageId: `${tag}_w_${name}`, botId: bot, ...extra })
      const toRenew = await seed("renew", { claimed: { revision: 1 } })
      const toCancel = await seed("cancel", { claimed: { revision: 1 } })
      const toRetarget = await seed("retarget", { targetRuntimeSessionId: runtimeSession })
      const toPin = await seed("pin", { claimed: { revision: 1 } })

      const changed = await reachedThrough(async (ws) => {
        await BotInvocationRepository.renewClaim(pool, {
          workspaceId: ws,
          botId: bot,
          invocationId: toRenew,
          instanceId: "inst_scope",
          claimToken: `tok_${toRenew}`,
          claimTtlSeconds: 7200,
        })
        await BotInvocationRepository.cancelClaim(pool, {
          workspaceId: ws,
          invocationId: toCancel,
          reason: "source_deleted",
        })
        await BotInvocationRepository.cancelActiveByTargetRuntimeSession(pool, {
          workspaceId: ws,
          botId: bot,
          runtimeSessionId: runtimeSession,
        })
        await BotInvocationRepository.pinClaimSource(pool, {
          workspaceId: ws,
          invocationId: toPin,
          instanceId: "inst_scope",
          claimToken: `tok_${toPin}`,
          revision: 5,
          promptMarkdown: "pinned",
        })
        return invocationStates([toRenew, toCancel, toRetarget, toPin])
      })

      const claimed = {
        status: "claimed",
        promptMarkdown: "prompt",
        sourceRevision: 0,
        claimedRevision: 1,
        cancellationReason: null,
        leaseExtended: false,
      }
      const pending = { ...claimed, status: "pending", claimedRevision: null }
      expect(changed).toEqual({
        other: { [toRenew]: claimed, [toCancel]: claimed, [toRetarget]: pending, [toPin]: claimed },
        own: {
          [toRenew]: { ...claimed, leaseExtended: true },
          [toCancel]: { ...claimed, status: "cancelled", cancellationReason: "source_deleted" },
          [toRetarget]: { ...pending, status: "cancelled", cancellationReason: "routing_changed" },
          [toPin]: { ...claimed, promptMarkdown: "pinned", sourceRevision: 5, claimedRevision: 5 },
        },
      })
    })
  })

  describe("bot invocation recording", () => {
    const recordingParams = (o: {
      id: string
      workspaceId: string
      stream: string
      source: string
      bot: string
      revision: number
    }) => ({
      id: o.id,
      workspaceId: o.workspaceId,
      rootStreamId: o.stream,
      activeStreamId: o.stream,
      sourceMessageId: o.source,
      responseStreamId: o.stream,
      actorType: "bot" as const,
      actorId: o.bot,
      trigger: "active-scratchpad" as const,
      requiredCapability: "active-scratchpad" as const,
      promptMarkdown: "prompt",
      sourceMessageRevision: o.revision,
      authorUserId: author,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })

    test("should insert when the terminal turn for the source is in another workspace when recording an invocation", async () => {
      const bot = botId()
      const stream = streamId()
      const source = `${tag}_ii1`
      const terminal = await insertInvocation({
        streamId: stream,
        sourceMessageId: source,
        botId: bot,
        status: "completed",
        claimToken: "tok_ii1",
        sourceMessageRevision: 3,
      })
      const insertedInB = botInvocationId()

      const recorded = await reachedThrough(async (ws) => {
        const result = await BotInvocationRepository.insertIdempotent(
          pool,
          recordingParams({
            id: ws === wsB ? insertedInB : botInvocationId(),
            workspaceId: ws,
            stream,
            source,
            bot,
            revision: 2,
          })
        )
        return { id: result.invocation.id, wasNewlyInserted: result.wasNewlyInserted }
      })

      expect(recorded).toEqual({
        other: { id: insertedInB, wasNewlyInserted: true },
        own: { id: terminal, wasNewlyInserted: false },
      })
    })

    test("should return the terminal turn of its own workspace when a newer one for the same source is in another workspace", async () => {
      const bot = botId()
      const stream = streamId()
      const source = `${tag}_ii2`
      const terminal = {
        streamId: stream,
        sourceMessageId: source,
        botId: bot,
        status: "completed",
        claimToken: "tok_ii2",
        sourceMessageRevision: 3,
      }
      const olderInB = await insertInvocation({
        ...terminal,
        workspaceId: wsB,
        createdAt: new Date(Date.now() - 600_000),
      })
      const newerInA = await insertInvocation({
        ...terminal,
        workspaceId: wsA,
        createdAt: new Date(Date.now() - 60_000),
      })

      const recorded = await reachedThrough(async (ws) => {
        const result = await BotInvocationRepository.insertIdempotent(
          pool,
          recordingParams({ id: botInvocationId(), workspaceId: ws, stream, source, bot, revision: 2 })
        )
        return { id: result.invocation.id, wasNewlyInserted: result.wasNewlyInserted }
      })

      expect(recorded).toEqual({
        other: { id: olderInB, wasNewlyInserted: false },
        own: { id: newerInA, wasNewlyInserted: false },
      })
    })

    test("should compare routing against its own workspace's pending invocation when a source is re-routed", async () => {
      const bot = botId()
      const source = `${tag}_ii3`
      const [lowerWorkspace, higherWorkspace] = [wsA, wsB].sort()
      const oldStream = streamId()
      const newStream = streamId()
      const pendingIn = (ws: string, stream: string) =>
        insertInvocation({
          workspaceId: ws,
          streamId: stream,
          sourceMessageId: source,
          botId: bot,
          sourceMessageRevision: 1,
        })
      await pendingIn(lowerWorkspace!, newStream)
      const own = await pendingIn(higherWorkspace!, oldStream)

      const result = await BotInvocationRepository.insertIdempotent(
        pool,
        recordingParams({
          id: botInvocationId(),
          workspaceId: higherWorkspace!,
          stream: newStream,
          source,
          bot,
          revision: 2,
        })
      )

      expect({
        id: result.invocation.id,
        wasNewlyInserted: result.wasNewlyInserted,
        routingDestinationChanged: result.routingDestinationChanged,
        activeStreamId: result.invocation.activeStreamId,
      }).toEqual({ id: own, wasNewlyInserted: false, routingDestinationChanged: true, activeStreamId: newStream })
    })
  })

  describe("bot invocation claiming", () => {
    test("should claim the invocation of its own workspace when another workspace has an older one for the same bot", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_c1`
      await insertInstance(wsA, bot, instanceId)
      const neighbour = await insertInvocation({
        workspaceId: wsB,
        sourceMessageId: `${tag}_c1b`,
        botId: bot,
        createdAt: new Date(Date.now() - 600_000),
      })
      const own = await insertInvocation({
        sourceMessageId: `${tag}_c1a`,
        botId: bot,
        createdAt: new Date(Date.now() - 300_000),
      })

      const next = idOf(await BotInvocationRepository.findNextClaimable(pool, claimParams(bot, instanceId)))
      const claimed = idOf(await claimNext(bot, instanceId, "tok_c1"))

      expect({ next, claimed, stored: await invocationStatuses([neighbour, own]) }).toEqual({
        next: own,
        claimed: own,
        stored: { [neighbour]: "pending", [own]: "claimed" },
      })
    })

    test("should claim nothing when the instance is registered only in another workspace", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_c2`
      await insertInstance(wsB, bot, instanceId)
      const own = await insertInvocation({ sourceMessageId: `${tag}_c2`, botId: bot })

      const next = idOf(await BotInvocationRepository.findNextClaimable(pool, claimParams(bot, instanceId)))
      const claimed = idOf(await claimNext(bot, instanceId, "tok_c2"))

      expect({ next, claimed, stored: await invocationStatuses([own]) }).toEqual({
        next: null,
        claimed: null,
        stored: { [own]: "pending" },
      })
    })

    test("should take the input update mode from its own workspace's instance when the same instance id is registered in another", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_c3`
      await insertInstance(wsA, bot, instanceId, { manifest: { input: { updates: "live" } } })
      await insertInstance(wsB, bot, instanceId, { manifest: { input: { updates: "restart" } } })
      await insertInvocation({ sourceMessageId: `${tag}_c3`, botId: bot })

      const claimed = await claimNext(bot, instanceId, "tok_c3")

      expect(claimed?.claimedInputUpdateMode).toBe("live")
    })
  })

  describe("sealed-stream claim gate and bootstrap", () => {
    const gateBot = botId()
    const gateInstance = `inst_${tag}_gate`

    interface GateCase {
      sealedIn?: string
      keyIn?: string[]
      holderIn?: string[]
      wraps?: { ws: string; generation: number }[]
      messageIn?: string
      messageGeneration?: number
      trigger?: string
    }

    async function seedGateCase(label: string, spec: GateCase) {
      const stream = streamId()
      const keyId = `e2ek_${tag}_${label}`
      if (spec.sealedIn) await sealStream(stream, spec.sealedIn)
      for (const ws of spec.keyIn ?? []) await insertRuntimeKey(ws, keyId)
      for (const ws of spec.holderIn ?? []) await insertKeyHolder(ws, keyId, gateBot, gateInstance)
      for (const wrap of spec.wraps ?? []) await insertWrap(wrap.ws, stream, wrap.generation, keyId)
      const message = await insertMessage(spec.messageIn ?? wsA, stream, { keyGeneration: spec.messageGeneration })
      return insertInvocation({ streamId: stream, sourceMessageId: message, botId: gateBot, trigger: spec.trigger })
    }

    test("should advertise a sealed turn only when every key, holder, wrap and message is in the invocation's workspace", async () => {
      const own = { sealedIn: wsA, keyIn: [wsA], holderIn: [wsA], messageGeneration: 2 }
      const cases = {
        sealedAndCovered: await seedGateCase("ctrl", { ...own, wraps: [{ ws: wsA, generation: 2 }] }),
        plaintextBesideForeignSealing: await seedGateCase("g1", { sealedIn: wsB }),
        keyOnlyInOtherWorkspace: await seedGateCase("g3", {
          ...own,
          keyIn: [wsB],
          wraps: [{ ws: wsA, generation: 2 }],
        }),
        keyAndHolderInOtherWorkspace: await seedGateCase("g4", {
          ...own,
          keyIn: [wsB],
          holderIn: [wsB],
          wraps: [{ ws: wsA, generation: 2 }],
        }),
        sessionControlWrapInOtherWorkspace: await seedGateCase("g5", {
          ...own,
          trigger: "session-control",
          wraps: [{ ws: wsB, generation: 2 }],
        }),
        triggerWrapInOtherWorkspace: await seedGateCase("g6", {
          ...own,
          messageGeneration: 1,
          wraps: [
            { ws: wsA, generation: 2 },
            { ws: wsB, generation: 1 },
          ],
        }),
        messageInOtherWorkspace: await seedGateCase("g7", {
          ...own,
          messageIn: wsB,
          wraps: [{ ws: wsA, generation: 2 }],
        }),
      }

      const { available } = await bootstrapInvocations(gateBot, gateInstance)
      const advertised = new Set(available.map((invocation) => invocation.id))

      expect(
        Object.fromEntries(Object.entries(cases).map(([label, invocation]) => [label, advertised.has(invocation)]))
      ).toEqual({
        sealedAndCovered: true,
        plaintextBesideForeignSealing: true,
        keyOnlyInOtherWorkspace: false,
        keyAndHolderInOtherWorkspace: false,
        sessionControlWrapInOtherWorkspace: false,
        triggerWrapInOtherWorkspace: false,
        messageInOtherWorkspace: false,
      })
    })

    test("should list only the workspace's own pending, claimed and cancelled invocations when bootstrapping a runtime", async () => {
      const bot = botId()
      const instanceId = `inst_${tag}_bs`
      const stream = streamId()
      const seed = (ws: string, name: string, extra: Partial<InvocationSeed>) =>
        insertInvocation({
          workspaceId: ws,
          streamId: stream,
          sourceMessageId: `${tag}_bs_${ws}_${name}`,
          botId: bot,
          ...extra,
        })
      const world = async (ws: string) => ({
        pending: await seed(ws, "pending", {}),
        claimed: await seed(ws, "claimed", { claimed: { revision: 1 }, claimedByInstanceId: instanceId }),
        cancelled: await seed(ws, "cancelled", {
          status: "cancelled",
          cancellationReason: "source_deleted",
          claimedByInstanceId: instanceId,
        }),
      })
      const own = await world(wsA)
      await world(wsB)

      const bootstrap = await bootstrapInvocations(bot, instanceId)

      expect({
        available: idsOf(bootstrap.available),
        ownedClaims: idsOf(bootstrap.ownedClaims),
        recentCancellations: bootstrap.recentCancellations.map((cancellation) => cancellation.invocationId),
      }).toEqual({ available: [own.pending], ownedClaims: [own.claimed], recentCancellations: [own.cancelled] })
    })
  })

  describe("bot channel grant lookups", () => {
    test("should find a grant only through its own workspace when checking, filtering, locking or listing a stream's grants", async () => {
      const bot = await insertBot(wsA)
      const stream = await insertStream(wsA)
      await insertGrant(wsA, bot, stream)

      const reached = await reachedThrough(async (ws) => ({
        filtered: [...(await BotChannelAccessRepository.filterGrantedStreamIds(pool, ws, bot, [stream]))],
        granted: await BotChannelAccessRepository.hasGrant(pool, ws, bot, stream),
        locked: [
          ...(await withTransaction(pool, (client) =>
            BotChannelAccessRepository.lockGrants(client, ws, bot, [stream])
          )),
        ],
        grantedBotIds: await BotChannelAccessRepository.getGrantedBotIds(pool, ws, stream),
      }))

      expect(reached).toEqual({
        other: { filtered: [], granted: false, locked: [], grantedBotIds: [] },
        own: { filtered: [stream], granted: true, locked: [stream], grantedBotIds: [bot] },
      })
    })

    test("should delete a grant only through its own workspace when revoking one channel or all of a bot's channels", async () => {
      const [bot1, bot2] = [botId(), botId()]
      const [stream1, stream2] = [streamId(), streamId()]
      await insertGrant(wsA, bot1, stream1)
      await insertGrant(wsA, bot2, stream2)
      const grantCounts = async () => {
        const rows = await pool.query<{ bot_id: string; count: string }>(
          `SELECT bot_id, COUNT(*) AS count FROM bot_channel_access WHERE bot_id = ANY($1) GROUP BY bot_id`,
          [[bot1, bot2]]
        )
        return Object.fromEntries(rows.rows.map((row) => [row.bot_id, Number(row.count)]))
      }

      const reached = await reachedThrough(async (ws) => {
        const revoked = await BotChannelAccessRepository.revokeAccess(pool, ws, bot1, stream1)
        const afterRevoke = await grantCounts()
        await BotChannelAccessRepository.revokeAllByBot(pool, ws, bot2)
        return { revoked, afterRevoke, afterRevokeAll: await grantCounts() }
      })

      expect(reached).toEqual({
        other: {
          revoked: false,
          afterRevoke: { [bot1]: 1, [bot2]: 1 },
          afterRevokeAll: { [bot1]: 1, [bot2]: 1 },
        },
        own: { revoked: true, afterRevoke: { [bot2]: 1 }, afterRevokeAll: {} },
      })
    })

    test("should delegate to the owner only when the bot and the owner's user row are in the given workspace when reading as the owner", async () => {
      const ownerHere = await insertUser(wsA)
      const ownerElsewhere = await insertUser(wsB)
      const botWithOwnerHere = await insertBot(wsA, { owner: ownerHere, readsAsOwner: true })
      const botWithOwnerElsewhere = await insertBot(wsA, { owner: ownerElsewhere, readsAsOwner: true })

      const reached = await reachedThrough(async (ws) => ({
        ownerHere: await BotChannelAccessRepository.getReadAsOwnerDelegate(pool, ws, botWithOwnerHere),
        ownerElsewhere: await BotChannelAccessRepository.getReadAsOwnerDelegate(pool, ws, botWithOwnerElsewhere),
      }))

      expect(reached).toEqual({
        other: { ownerHere: null, ownerElsewhere: null },
        own: { ownerHere, ownerElsewhere: null },
      })
    })
  })

  describe("API key ownership-checked statements", () => {
    async function managedThrough(kind: ApiKeyKind, calls: ApiKeyManagement) {
      const owner = API_KEYS[kind].newOwner()
      const bulkOwner = API_KEYS[kind].newOwner()
      const key = await insertApiKey(kind, wsA, owner)
      const bulkKey = await insertApiKey(kind, wsA, bulkOwner)

      const reached = await reachedThrough(async (ws) => ({
        ...(calls.find && { found: idOf(await calls.find(ws, owner, key)) }),
        listed: idsOf(await calls.list(ws, owner)),
        scopes: idOf(await calls.updateScopes(ws, owner, key)),
        version: idOf(await calls.updateVersion(ws, owner, key)),
        revoked: await calls.revoke(ws, owner, key),
        revokedAll: await calls.revokeAll(ws, bulkOwner),
        stored: Object.fromEntries(
          (await apiKeyRows(kind, [key, bulkKey])).map((row) => [
            row.id,
            { scopes: row.scopes, apiVersion: row.api_version, revoked: row.revoked },
          ])
        ),
      }))

      return { key, bulkKey, reached }
    }

    const keyManagementOutcome = (key: string, bulkKey: string) => {
      const untouched = { scopes: ["messages:read"], apiVersion: null, revoked: false }
      return {
        other: {
          listed: [],
          scopes: null,
          version: null,
          revoked: "not_found",
          revokedAll: 0,
          stored: { [key]: untouched, [bulkKey]: untouched },
        },
        own: {
          listed: [key],
          scopes: key,
          version: key,
          revoked: "ok",
          revokedAll: 1,
          stored: {
            [key]: { scopes: ["messages:write"], apiVersion: CURRENT_API_VERSION, revoked: true },
            [bulkKey]: { ...untouched, revoked: true },
          },
        },
      }
    }

    test("should list, change and revoke a bot API key only through its own workspace when managing a bot's keys", async () => {
      const { key, bulkKey, reached } = await managedThrough("bot", {
        list: (ws, owner) => BotApiKeyRepository.listByBot(pool, ws, owner),
        updateScopes: (ws, owner, id) => BotApiKeyRepository.updateScopesOwned(pool, ws, owner, id, ["messages:write"]),
        updateVersion: (ws, owner, id) =>
          BotApiKeyRepository.updateApiVersionOwned(pool, ws, owner, id, CURRENT_API_VERSION),
        revoke: (ws, owner, id) => BotApiKeyRepository.revokeOwned(pool, ws, owner, id),
        revokeAll: (ws, owner) => BotApiKeyRepository.revokeAllByBot(pool, ws, owner),
      })

      expect(reached).toEqual(keyManagementOutcome(key, bulkKey))
    })

    test("should find, list, change and revoke a user API key only through its own workspace when managing a user's keys", async () => {
      const { key, bulkKey, reached } = await managedThrough("user", {
        find: (ws, _owner, id) => UserApiKeyRepository.findById(pool, ws, id),
        list: (ws, owner) => UserApiKeyRepository.listByUser(pool, ws, owner),
        updateScopes: (ws, owner, id) =>
          UserApiKeyRepository.updateScopesOwned(pool, ws, owner, id, ["messages:write"]),
        updateVersion: (ws, owner, id) =>
          UserApiKeyRepository.updateApiVersionOwned(pool, ws, owner, id, CURRENT_API_VERSION),
        revoke: (ws, owner, id) => UserApiKeyRepository.revokeOwned(pool, ws, owner, id),
        revokeAll: (ws, owner) => UserApiKeyRepository.revokeAllByUser(pool, ws, owner),
      })

      const expected = keyManagementOutcome(key, bulkKey)
      expect(reached).toEqual({
        other: { ...expected.other, found: null },
        own: { ...expected.own, found: key },
      })
    })
  })

  describe("sandbox session tokens", () => {
    test("should revoke a token only through its own workspace when revoking a sandbox session token", async () => {
      const tokenHash = `hash_${tag}_sandbox`
      const token = await SandboxSessionTokenRepository.insert(pool, {
        id: sandboxSessionTokenId(),
        workspaceId: wsA,
        invokingUserId: author,
        personaId: "persona_scope",
        sessionId: "session_scope",
        streamId: streamId(),
        capturedStreamIds: [],
        tokenHash,
        ttlSec: 3600,
      })

      const reached = await reachedThrough(async (ws) => {
        await SandboxSessionTokenRepository.revoke(pool, ws, token.id)
        return idOf(await SandboxSessionTokenRepository.findLiveByHash(pool, tokenHash))
      })

      expect(reached).toEqual({ other: token.id, own: null })
    })
  })

  describe("bot lookups and edits", () => {
    test("should find and change a bot only through its own workspace when looking it up or editing it by id, key, slug or owner", async () => {
      const owner = userId()
      const apiKey = botApiKeyId()
      const personal = await insertBot(wsA, { owner, apiKeyId: apiKey })
      const shared = await insertBot(wsA)
      const archivedBot = await insertBot(wsA, { owner, archived: true })
      const ids = [personal, shared, archivedBot]
      const stored = async () => {
        const rows = await pool.query<{
          id: string
          name: string
          traits: string[]
          avatar_url: string | null
          archived: boolean
        }>(`SELECT id, name, traits, avatar_url, archived_at IS NOT NULL AS archived FROM bots WHERE id = ANY($1)`, [
          ids,
        ])
        return Object.fromEntries(
          rows.rows.map((row) => [
            row.id,
            { name: row.name, traits: row.traits, avatarUrl: row.avatar_url, archived: row.archived },
          ])
        )
      }

      const reached = await reachedThrough(async (ws) => ({
        read: {
          byApiKey: idOf(await BotRepository.findByApiKeyId(pool, ws, apiKey)),
          byId: idOf(await BotRepository.findById(pool, ws, personal)),
          forUpdate: idOf(
            await withTransaction(pool, (client) => BotRepository.findByIdForUpdate(client, ws, personal))
          ),
          byIds: idsOf(await BotRepository.findByIds(pool, ws, ids)),
          listed: idsOf((await BotRepository.listByWorkspace(pool, ws)).filter((bot) => ids.includes(bot.id))),
          bySlug: idsOf(await BotRepository.findBySlugs(pool, ws, [`bot-${personal}`])),
          invocable: idsOf(await BotRepository.findInvocableByIds(pool, ws, owner, ids)),
          byOwner: idsOf(await BotRepository.listByOwner(pool, ws, owner)),
        },
        written: {
          unchanged: idOf(await BotRepository.update(pool, personal, ws, {})),
          renamed: idOf(await BotRepository.update(pool, personal, ws, { name: "renamed" })),
          traited: idOf(await BotRepository.addTraitsIfMissing(pool, personal, ws, ["mentionable"])),
          avatar: idOf(await BotRepository.updateAvatarUrl(pool, personal, ws, "https://example.test/avatar.png")),
          restored: idOf(await BotRepository.restore(pool, archivedBot, ws)),
          archived: idOf(await BotRepository.archive(pool, personal, ws)),
        },
        stored: await stored(),
      }))

      const initial = {
        [personal]: { name: `bot-${personal}`, traits: [], avatarUrl: null, archived: false },
        [shared]: { name: `bot-${shared}`, traits: [], avatarUrl: null, archived: false },
        [archivedBot]: { name: `bot-${archivedBot}`, traits: [], avatarUrl: null, archived: true },
      }
      expect(reached).toEqual({
        other: {
          read: {
            byApiKey: null,
            byId: null,
            forUpdate: null,
            byIds: [],
            listed: [],
            bySlug: [],
            invocable: [],
            byOwner: [],
          },
          written: { unchanged: null, renamed: null, traited: null, avatar: null, restored: null, archived: null },
          stored: initial,
        },
        own: {
          read: {
            byApiKey: personal,
            byId: personal,
            forUpdate: personal,
            byIds: [...ids].sort(),
            listed: [personal, shared].sort(),
            bySlug: [personal],
            invocable: [personal, shared].sort(),
            byOwner: [personal],
          },
          written: {
            unchanged: personal,
            renamed: personal,
            traited: personal,
            avatar: personal,
            restored: archivedBot,
            archived: personal,
          },
          stored: {
            [personal]: {
              name: "renamed",
              traits: ["mentionable"],
              avatarUrl: "https://example.test/avatar.png",
              archived: true,
            },
            [shared]: initial[shared],
            [archivedBot]: { ...initial[archivedBot], archived: false },
          },
        },
      })
    })

    test("should not show a personal bot whose only grant belongs to another workspace when its stream is public", async () => {
      const viewer = userId()
      const otherOwner = userId()
      const publicStream = await insertStream(wsA, { visibility: "public" })
      const grantedHere = await insertBot(wsA, { owner: otherOwner })
      const grantedElsewhere = await insertBot(wsA, { owner: otherOwner })
      await insertGrant(wsA, grantedHere, publicStream)
      await insertGrant(wsB, grantedElsewhere, publicStream)
      const candidates = [grantedHere, grantedElsewhere]

      expect({
        listed: idsOf(
          (await BotRepository.listVisibleTo(pool, wsA, viewer)).filter((bot) => candidates.includes(bot.id))
        ),
        foundHere: idOf(await BotRepository.findVisibleTo(pool, wsA, viewer, grantedHere)),
        foundElsewhere: idOf(await BotRepository.findVisibleTo(pool, wsA, viewer, grantedElsewhere)),
      }).toEqual({ listed: [grantedHere], foundHere: grantedHere, foundElsewhere: null })
    })
  })
})
