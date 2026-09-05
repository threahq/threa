import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { userId, workspaceId, streamId } from "../../src/lib/id"

describe("E2eStreamsRepository.findE2eStreamIds", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seed(): Promise<{ wsId: string; sealedId: string; plainId: string; otherWsSealedId: string }> {
    const wsId = workspaceId()
    const otherWsId = workspaceId()
    const sealedId = streamId()
    const plainId = streamId()
    const otherWsSealedId = streamId()

    await withTransaction(pool, async (client) => {
      for (const [id, name] of [
        [wsId, "Batch Lookup WS"],
        [otherWsId, "Other WS"],
      ] as const) {
        await WorkspaceRepository.insert(client, {
          id,
          name,
          slug: `batch-lookup-${id}`,
          createdBy: userId(),
        })
      }
      const owner = (await addTestMember(client, wsId, userId())).id
      const otherOwner = (await addTestMember(client, otherWsId, userId())).id

      for (const [id, ws, createdBy] of [
        [sealedId, wsId, owner],
        [plainId, wsId, owner],
        [otherWsSealedId, otherWsId, otherOwner],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.SCRATCHPAD,
          createdBy,
        })
      }

      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: sealedId,
        workspaceId: wsId,
        ownerUserId: owner,
        ownerUserKeyId: "e2ek_owner",
      })
      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: otherWsSealedId,
        workspaceId: otherWsId,
        ownerUserId: otherOwner,
        ownerUserKeyId: "e2ek_other",
      })
    })

    return { wsId, sealedId, plainId, otherWsSealedId }
  }

  test("should return only the E2E streams of the given workspace when asked for a batch of ids", async () => {
    const { wsId, sealedId, plainId, otherWsSealedId } = await seed()

    const found = await E2eStreamsRepository.findE2eStreamIds(pool, wsId, [
      sealedId,
      plainId,
      otherWsSealedId,
      streamId(),
    ])

    expect(found).toEqual(new Set([sealedId]))
  })

  test("should return an empty set when no ids are given", async () => {
    const { wsId } = await seed()

    expect(await E2eStreamsRepository.findE2eStreamIds(pool, wsId, [])).toEqual(new Set())
  })
})
