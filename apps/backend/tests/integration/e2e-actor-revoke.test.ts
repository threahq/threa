import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { E2eStreamActorsRepository, StreamE2eKeyWrapsRepository } from "../../src/features/e2e-streams"
import { streamId, workspaceId, userId } from "../../src/lib/id"

/**
 * Revoking an actor against the real schema: the actor row goes from the root
 * and every thread under it, and the wraps only that bot's keys could open go
 * with it — while a key shared with a bot that keeps its grant survives.
 */
describe("E2E actor revoke", () => {
  let pool: Pool
  const ws = workspaceId()
  const otherWs = workspaceId()
  const owner = userId()
  const botA = `bot_${Math.random().toString(36).slice(2, 10)}`
  const botB = `bot_${Math.random().toString(36).slice(2, 10)}`
  const root = streamId()
  const thread = streamId()
  const deepThread = streamId()
  const otherRoot = streamId()
  const otherWsRoot = streamId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  async function cleanup(): Promise<void> {
    for (const w of [ws, otherWs]) {
      await pool.query("DELETE FROM runtime_e2e_key_holders WHERE workspace_id = $1", [w])
      await pool.query("DELETE FROM runtime_e2e_keys WHERE workspace_id = $1", [w])
      await pool.query("DELETE FROM stream_e2e_key_wraps WHERE workspace_id = $1", [w])
      await pool.query("DELETE FROM e2e_stream_actors WHERE workspace_id = $1", [w])
      await pool.query("DELETE FROM streams WHERE workspace_id = $1", [w])
    }
  }

  async function insertStream(params: { id: string; workspaceId: string; rootStreamId?: string }): Promise<void> {
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, created_by, parent_stream_id, root_stream_id)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [params.id, params.workspaceId, params.rootStreamId ? "thread" : "scratchpad", owner, params.rootStreamId ?? null]
    )
  }

  async function registerKey(params: { keyId: string; holders: string[] }): Promise<void> {
    await pool.query("INSERT INTO runtime_e2e_keys (workspace_id, key_id, public_key) VALUES ($1, $2, 'pk')", [
      ws,
      params.keyId,
    ])
    for (const botId of params.holders) {
      await pool.query(
        `INSERT INTO runtime_e2e_key_holders (workspace_id, key_id, bot_id, instance_id)
         VALUES ($1, $2, $3, $4)`,
        [ws, params.keyId, botId, `inst_${botId}`]
      )
    }
  }

  async function wrap(params: {
    streamId: string
    keyId: string
    generation: number
    kind?: "bot" | "user" | "enclave"
  }): Promise<void> {
    await pool.query(
      `INSERT INTO stream_e2e_key_wraps
         (id, workspace_id, stream_id, key_generation, recipient_key_id, recipient_kind, wrap_enc, wrap_ct)
       VALUES ($1, $2, $3, $4, $5, $6, '\\x00', '\\x01')`,
      [
        `sekw_${Math.random().toString(36).slice(2)}`,
        ws,
        params.streamId,
        params.generation,
        params.keyId,
        params.kind ?? "bot",
      ]
    )
  }

  async function remainingWrapKeyIds(stream: string): Promise<string[]> {
    const result = await pool.query<{ recipient_key_id: string }>(
      "SELECT recipient_key_id FROM stream_e2e_key_wraps WHERE workspace_id = $1 AND stream_id = $2 ORDER BY recipient_key_id",
      [ws, stream]
    )
    return [...new Set(result.rows.map((row) => row.recipient_key_id))]
  }

  beforeEach(async () => {
    await cleanup()
    await insertStream({ id: root, workspaceId: ws })
    await insertStream({ id: thread, workspaceId: ws, rootStreamId: root })
    await insertStream({ id: deepThread, workspaceId: ws, rootStreamId: root })
    await insertStream({ id: otherRoot, workspaceId: ws })
    await insertStream({ id: otherWsRoot, workspaceId: otherWs })
  })

  test("removes the actor from the root and every thread under it, and nothing else", async () => {
    for (const stream of [root, thread, deepThread, otherRoot]) {
      await E2eStreamActorsRepository.add(pool, ws, stream, "bot", botA, null)
      await E2eStreamActorsRepository.add(pool, ws, stream, "bot", botB, null)
    }
    await E2eStreamActorsRepository.add(pool, ws, root, "enclave", "enclave", null)
    await E2eStreamActorsRepository.add(pool, otherWs, otherWsRoot, "bot", botA, null)

    const removed = await E2eStreamActorsRepository.removeFromStreamTree(pool, {
      workspaceId: ws,
      rootStreamId: root,
      kind: "bot",
      actorId: botA,
    })
    expect(removed).toBe(3)

    const survivors = await pool.query<{ stream_id: string; kind: string; actor_id: string }>(
      "SELECT stream_id, kind, actor_id FROM e2e_stream_actors WHERE workspace_id = $1 ORDER BY stream_id, actor_id",
      [ws]
    )
    expect(survivors.rows.filter((row) => row.actor_id === botA).map((row) => row.stream_id)).toEqual([otherRoot])
    expect(survivors.rows.filter((row) => row.kind === "enclave")).toHaveLength(1)
    expect(survivors.rows.filter((row) => row.actor_id === botB)).toHaveLength(4)

    const otherWsRows = await pool.query("SELECT 1 FROM e2e_stream_actors WHERE workspace_id = $1", [otherWs])
    expect(otherWsRows.rowCount).toBe(1)
  })

  test("revoking an actor that was never invited removes nothing", async () => {
    await E2eStreamActorsRepository.add(pool, ws, root, "bot", botB, null)

    expect(
      await E2eStreamActorsRepository.removeFromStreamTree(pool, {
        workspaceId: ws,
        rootStreamId: root,
        kind: "bot",
        actorId: botA,
      })
    ).toBe(0)
  })

  test("drops the revoked bot's exclusive wraps at every generation and keeps a shared host key", async () => {
    await registerKey({ keyId: "rek_a_only", holders: [botA] })
    await registerKey({ keyId: "rek_shared_host", holders: [botA, botB] })
    await registerKey({ keyId: "rek_b_only", holders: [botB] })

    for (const generation of [1, 2]) {
      for (const keyId of ["rek_a_only", "rek_shared_host", "rek_b_only"]) {
        await wrap({ streamId: root, keyId, generation })
      }
      await wrap({ streamId: root, keyId: "e2ek_owner", generation, kind: "user" })
      await wrap({ streamId: otherRoot, keyId: "rek_a_only", generation })
    }

    // botB keeps its grant, so the shared host key still has a live holder.
    await E2eStreamActorsRepository.add(pool, ws, root, "bot", botB, null)

    const deleted = await StreamE2eKeyWrapsRepository.deleteWrapsExclusiveToBot(pool, {
      workspaceId: ws,
      streamId: root,
      botId: botA,
    })
    expect(deleted).toBe(2)
    expect(await remainingWrapKeyIds(root)).toEqual(["e2ek_owner", "rek_b_only", "rek_shared_host"])
    expect(await remainingWrapKeyIds(otherRoot)).toEqual(["rek_a_only"])
  })

  test("drops a formerly shared key once no remaining actor holds it", async () => {
    await registerKey({ keyId: "rek_shared_host", holders: [botA, botB] })
    await wrap({ streamId: root, keyId: "rek_shared_host", generation: 1 })

    // Neither holder is an actor any more: the second revoke takes the wrap.
    const deleted = await StreamE2eKeyWrapsRepository.deleteWrapsExclusiveToBot(pool, {
      workspaceId: ws,
      streamId: root,
      botId: botA,
    })
    expect(deleted).toBe(1)
    expect(await remainingWrapKeyIds(root)).toEqual([])
  })
})
