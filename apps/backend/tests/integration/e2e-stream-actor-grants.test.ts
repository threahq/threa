import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamActorsRepository, E2eStreamsRepository } from "../../src/features/e2e-streams"
import { userId, workspaceId, streamId, botId } from "../../src/lib/id"

interface Seeded {
  wsId: string
  otherWsId: string
  bot: string
  otherBot: string
  sealedId: string
  sealedThreadId: string
  archivedId: string
  otherWsSealedId: string
}

describe("E2eStreamActorsRepository.listSealedRootsForBot", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seed(): Promise<Seeded> {
    const wsId = workspaceId()
    const otherWsId = workspaceId()
    const bot = botId()
    const otherBot = botId()
    const sealedId = streamId()
    const sealedThreadId = streamId()
    const archivedId = streamId()
    const otherWsSealedId = streamId()

    await withTransaction(pool, async (client) => {
      for (const [id, name] of [
        [wsId, "Grants WS"],
        [otherWsId, "Other Grants WS"],
      ] as const) {
        await WorkspaceRepository.insert(client, { id, name, slug: `grants-${id}`, createdBy: userId() })
      }
      const owner = (await addTestMember(client, wsId, userId())).id
      const otherOwner = (await addTestMember(client, otherWsId, userId())).id

      for (const [id, ws, createdBy] of [
        [sealedId, wsId, owner],
        [archivedId, wsId, owner],
        [otherWsSealedId, otherWsId, otherOwner],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.SCRATCHPAD,
          createdBy,
        })
      }
      await StreamRepository.update(client, archivedId, { archivedAt: new Date() })
      await StreamRepository.insert(client, {
        id: sealedThreadId,
        workspaceId: wsId,
        type: StreamTypes.THREAD,
        parentStreamId: sealedId,
        rootStreamId: sealedId,
        createdBy: owner,
      })

      for (const [id, ws, ownerUserId] of [
        [sealedId, wsId, owner],
        [archivedId, wsId, owner],
        [otherWsSealedId, otherWsId, otherOwner],
      ] as const) {
        await E2eStreamsRepository.markStreamE2e(client, {
          streamId: id,
          workspaceId: ws,
          ownerUserId,
          ownerUserKeyId: "e2ek_owner",
        })
      }

      // The bot is an actor everywhere it could plausibly be listed; only the
      // live, in-workspace root should come back.
      for (const [ws, stream] of [
        [wsId, sealedId],
        [wsId, sealedThreadId],
        [wsId, archivedId],
        [otherWsId, otherWsSealedId],
      ] as const) {
        await E2eStreamActorsRepository.add(client, ws, stream, "bot", bot, null)
      }
      await E2eStreamActorsRepository.add(client, wsId, sealedId, "bot", otherBot, null)
      await E2eStreamActorsRepository.add(client, wsId, sealedId, "enclave", "e2e_enclave", null)
    })

    return { wsId, otherWsId, bot, otherBot, sealedId, sealedThreadId, archivedId, otherWsSealedId }
  }

  test("should exclude threads, archived roots, other workspaces, and other actors", async () => {
    const { wsId, otherWsId, bot, otherBot, sealedId, otherWsSealedId } = await seed()

    expect(
      await E2eStreamActorsRepository.listSealedRootsForBot(pool, { workspaceId: wsId, botId: bot, limit: 50 })
    ).toEqual([sealedId])
    expect(
      await E2eStreamActorsRepository.listSealedRootsForBot(pool, { workspaceId: wsId, botId: otherBot, limit: 50 })
    ).toEqual([sealedId])
    expect(
      await E2eStreamActorsRepository.listSealedRootsForBot(pool, {
        workspaceId: otherWsId,
        botId: bot,
        limit: 50,
      })
    ).toEqual([otherWsSealedId])
  })

  test("should return the most recent grants first and stop at the limit", async () => {
    const { wsId, bot } = await seed()
    const extra = [streamId(), streamId()]

    await withTransaction(pool, async (client) => {
      const owner = (await addTestMember(client, wsId, userId())).id
      for (const id of extra) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
          createdBy: owner,
        })
        await E2eStreamsRepository.markStreamE2e(client, {
          streamId: id,
          workspaceId: wsId,
          ownerUserId: owner,
          ownerUserKeyId: "e2ek_owner",
        })
        await E2eStreamActorsRepository.add(client, wsId, id, "bot", bot, null)
      }
    })

    // The extras were granted in a later transaction than the seed's root, so
    // they are the two most recent; their order within one transaction is the
    // stream-id tiebreaker.
    expect(
      await E2eStreamActorsRepository.listSealedRootsForBot(pool, { workspaceId: wsId, botId: bot, limit: 2 })
    ).toEqual(extra.slice().sort().reverse())
  })
})
