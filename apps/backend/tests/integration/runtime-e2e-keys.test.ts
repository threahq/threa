import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import {
  BotInvocationRepository,
  BotRuntimeService,
  RuntimeE2eKeysRepository,
  BOT_RUNTIME_BIK_STALENESS_MS,
} from "../../src/features/bot-runtimes"
import { streamId, workspaceId, userId, messageId } from "../../src/lib/id"

/**
 * The scoped key registry against the real schema: what a presence write
 * registers, which keys a stream's wraps are addressed to, and which keys let an
 * instance claim a sealed turn.
 */
describe("runtime E2E key registry", () => {
  let pool: Pool
  let service: BotRuntimeService
  const ws = workspaceId()
  const owner = userId()
  const botA = `bot_${Math.random().toString(36).slice(2, 10)}`
  const botB = `bot_${Math.random().toString(36).slice(2, 10)}`
  const sealedStream = streamId()
  const otherSealedStream = streamId()

  let nextSequence = 1
  const b64 = (seed: string) => Buffer.from(seed.padEnd(32, "0").slice(0, 32)).toString("base64")

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new BotRuntimeService({ pool })
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM bot_runtime_instances WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM runtime_e2e_key_holders WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM runtime_e2e_keys WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM stream_e2e_key_wraps WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM e2e_streams WHERE workspace_id = $1", [ws])
    await pool.query("DELETE FROM messages WHERE stream_id = ANY($1)", [[sealedStream, otherSealedStream]])
  }

  beforeEach(cleanup)

  async function sealStream(id: string, generation: number): Promise<void> {
    await pool.query(
      `INSERT INTO e2e_streams (stream_id, workspace_id, owner_user_id, owner_user_key_id, current_key_generation)
       VALUES ($1, $2, $3, 'e2ek_owner', $4)`,
      [id, ws, owner, generation]
    )
  }

  async function wrap(params: { streamId: string; keyId: string; generation: number }): Promise<void> {
    await pool.query(
      `INSERT INTO stream_e2e_key_wraps (id, workspace_id, stream_id, key_generation, recipient_key_id, recipient_kind, wrap_enc, wrap_ct)
       VALUES ($1, $2, $3, $4, $5, 'bot', '\\x00', '\\x01')`,
      [`sekw_${Math.random().toString(36).slice(2)}`, ws, params.streamId, params.generation, params.keyId]
    )
  }

  async function presence(params: {
    botId: string
    instanceId: string
    keys?: { keyId: string; publicKey: string; streamId?: string }[]
    publicKey?: string
    publicKeyId?: string
  }): Promise<void> {
    await service.upsertPresenceFromBotKey({
      workspaceId: ws,
      botId: params.botId,
      runtimeKind: "claude-code-channel",
      instanceId: params.instanceId,
      status: "available",
      acceptingInvocations: true,
      ...(params.keys ? { e2eKeys: params.keys } : {}),
      ...(params.publicKey ? { publicKey: params.publicKey, publicKeyId: params.publicKeyId } : {}),
    })
  }

  async function seedSealedInvocation(params: {
    id: string
    botId: string
    streamId: string
    triggerGeneration: number
  }): Promise<void> {
    const trigger = messageId()
    await pool.query(
      `INSERT INTO messages (id, stream_id, sequence, author_id, author_type, content_json, content_markdown, revision, ciphertext, envelope)
       VALUES ($1, $2, $5, $3, 'user', '{"type":"doc"}', '[encrypted]', 1, '\\x02', $4)`,
      [
        trigger,
        params.streamId,
        owner,
        JSON.stringify({ v: 2, keyGeneration: params.triggerGeneration }),
        nextSequence++,
      ]
    )
    await BotInvocationRepository.insertIdempotent(pool, {
      id: params.id,
      workspaceId: ws,
      rootStreamId: params.streamId,
      activeStreamId: params.streamId,
      sourceMessageId: trigger,
      responseStreamId: params.streamId,
      actorType: "bot",
      actorId: params.botId,
      trigger: "active-scratchpad",
      requiredCapability: "active-scratchpad",
      promptMarkdown: "[encrypted]",
      sourceMessageRevision: 0,
      authorUserId: owner,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })
  }

  const claim = (botId: string, instanceId: string) =>
    BotInvocationRepository.claimOne(pool, {
      workspaceId: ws,
      botId,
      instanceId,
      runtimeKind: "claude-code-channel",
      claimToken: `tok_${Math.random().toString(36).slice(2)}`,
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
      maxAttempts: 5,
    })

  test("two bots sharing one host key are one wrap recipient, and both can claim under it", async () => {
    const hostKey = { keyId: "rek_host", publicKey: b64("host") }
    await presence({ botId: botA, instanceId: "inst_a", keys: [hostKey] })
    await presence({ botId: botB, instanceId: "inst_b", keys: [hostKey] })
    await sealStream(sealedStream, 1)
    await wrap({ streamId: sealedStream, keyId: "rek_host", generation: 1 })

    const recipientsA = await RuntimeE2eKeysRepository.listLiveForBot(pool, {
      workspaceId: ws,
      botId: botA,
      streamId: sealedStream,
      stalenessMs: BOT_RUNTIME_BIK_STALENESS_MS,
    })
    await seedSealedInvocation({ id: "binv_shared_a", botId: botA, streamId: sealedStream, triggerGeneration: 1 })
    await seedSealedInvocation({ id: "binv_shared_b", botId: botB, streamId: sealedStream, triggerGeneration: 1 })

    expect({
      recipientsA,
      claimedA: (await claim(botA, "inst_a"))?.id,
      claimedB: (await claim(botB, "inst_b"))?.id,
    }).toEqual({
      recipientsA: [{ keyId: "rek_host", publicKey: b64("host"), streamId: null }],
      claimedA: "binv_shared_a",
      claimedB: "binv_shared_b",
    })
  })

  test("a stream-scoped key is a recipient and a claim key on its own stream only", async () => {
    await presence({
      botId: botA,
      instanceId: "inst_a",
      keys: [{ keyId: "rek_scoped", publicKey: b64("scoped"), streamId: sealedStream }],
    })
    await sealStream(sealedStream, 1)
    await sealStream(otherSealedStream, 1)
    await wrap({ streamId: sealedStream, keyId: "rek_scoped", generation: 1 })
    await wrap({ streamId: otherSealedStream, keyId: "rek_scoped", generation: 1 })
    await seedSealedInvocation({ id: "binv_other", botId: botA, streamId: otherSealedStream, triggerGeneration: 1 })

    const recipientsElsewhere = await RuntimeE2eKeysRepository.listLiveForBot(pool, {
      workspaceId: ws,
      botId: botA,
      streamId: otherSealedStream,
      stalenessMs: BOT_RUNTIME_BIK_STALENESS_MS,
    })
    const eligibleElsewhere = await RuntimeE2eKeysRepository.listEligibleKeyIdsForInstance(pool, {
      workspaceId: ws,
      botId: botA,
      instanceId: "inst_a",
      streamId: otherSealedStream,
    })

    expect({
      recipientsElsewhere,
      eligibleElsewhere,
      claimedElsewhere: (await claim(botA, "inst_a"))?.id ?? null,
      eligibleHere: await RuntimeE2eKeysRepository.listEligibleKeyIdsForInstance(pool, {
        workspaceId: ws,
        botId: botA,
        instanceId: "inst_a",
        streamId: sealedStream,
      }),
      recipientsHere: await RuntimeE2eKeysRepository.listLiveForBot(pool, {
        workspaceId: ws,
        botId: botA,
        streamId: sealedStream,
        stalenessMs: BOT_RUNTIME_BIK_STALENESS_MS,
      }),
    }).toEqual({
      recipientsElsewhere: [],
      eligibleElsewhere: [],
      claimedElsewhere: null,
      eligibleHere: ["rek_scoped"],
      recipientsHere: [{ keyId: "rek_scoped", publicKey: b64("scoped"), streamId: sealedStream }],
    })
  })

  test("one key must cover both generations — two keys covering one each cannot claim", async () => {
    await presence({
      botId: botA,
      instanceId: "inst_a",
      keys: [
        { keyId: "rek_old", publicKey: b64("old") },
        { keyId: "rek_new", publicKey: b64("new") },
      ],
    })
    await sealStream(sealedStream, 2)
    await wrap({ streamId: sealedStream, keyId: "rek_old", generation: 1 })
    await wrap({ streamId: sealedStream, keyId: "rek_new", generation: 2 })
    await seedSealedInvocation({ id: "binv_split", botId: botA, streamId: sealedStream, triggerGeneration: 1 })

    expect((await claim(botA, "inst_a"))?.id ?? null).toBeNull()

    await wrap({ streamId: sealedStream, keyId: "rek_new", generation: 1 })
    expect((await claim(botA, "inst_a"))?.id).toBe("binv_split")
  })

  test("a legacy scalar BIK presence registers as one unscoped key and still claims", async () => {
    await presence({ botId: botA, instanceId: "inst_a", publicKey: b64("legacy"), publicKeyId: "bik_legacy" })
    await sealStream(sealedStream, 1)
    await wrap({ streamId: sealedStream, keyId: "bik_legacy", generation: 1 })
    await seedSealedInvocation({ id: "binv_legacy", botId: botA, streamId: sealedStream, triggerGeneration: 1 })

    expect({
      eligible: await RuntimeE2eKeysRepository.listEligibleKeyIdsForInstance(pool, {
        workspaceId: ws,
        botId: botA,
        instanceId: "inst_a",
        streamId: sealedStream,
      }),
      claimed: (await claim(botA, "inst_a"))?.id,
    }).toEqual({ eligible: ["bik_legacy"], claimed: "binv_legacy" })
  })

  test("a presence that stops advertising a key unregisters it, leaving the key row for its return", async () => {
    await presence({ botId: botA, instanceId: "inst_a", keys: [{ keyId: "rek_host", publicKey: b64("host") }] })
    await presence({ botId: botA, instanceId: "inst_a", keys: [] })
    const afterUnload = await RuntimeE2eKeysRepository.listEligibleKeyIdsForInstance(pool, {
      workspaceId: ws,
      botId: botA,
      instanceId: "inst_a",
      streamId: sealedStream,
    })
    await presence({ botId: botA, instanceId: "inst_a", keys: [{ keyId: "rek_host", publicKey: b64("host") }] })
    const keyRows = await pool.query("SELECT key_id FROM runtime_e2e_keys WHERE workspace_id = $1", [ws])

    expect({
      afterUnload,
      afterReload: await RuntimeE2eKeysRepository.listEligibleKeyIdsForInstance(pool, {
        workspaceId: ws,
        botId: botA,
        instanceId: "inst_a",
        streamId: sealedStream,
      }),
      keyRows: keyRows.rows,
    }).toEqual({ afterUnload: [], afterReload: ["rek_host"], keyRows: [{ key_id: "rek_host" }] })
  })

  test("re-registering a key id with different key material is refused", async () => {
    await presence({ botId: botA, instanceId: "inst_a", keys: [{ keyId: "rek_host", publicKey: b64("host") }] })

    await expect(
      presence({ botId: botB, instanceId: "inst_b", keys: [{ keyId: "rek_host", publicKey: b64("impostor") }] })
    ).rejects.toMatchObject({ code: "E2E_KEY_ID_CONFLICT" })

    const stored = await pool.query("SELECT public_key FROM runtime_e2e_keys WHERE workspace_id = $1 AND key_id = $2", [
      ws,
      "rek_host",
    ])
    expect(stored.rows).toEqual([{ public_key: b64("host") }])
  })
})
