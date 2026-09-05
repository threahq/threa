import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { userId, workspaceId, streamId } from "../../src/lib/id"

interface Seeded {
  wsId: string
  sealedId: string
  sealedThreadId: string
  plainId: string
  plainThreadId: string
  otherWsPlainId: string
}

describe("E2eStreamsRepository.excludeE2eRootedStreamIds", () => {
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
    const sealedId = streamId()
    const sealedThreadId = streamId()
    const plainId = streamId()
    const plainThreadId = streamId()
    const otherWsPlainId = streamId()

    await withTransaction(pool, async (client) => {
      for (const [id, name] of [
        [wsId, "Root Walk WS"],
        [otherWsId, "Other WS"],
      ] as const) {
        await WorkspaceRepository.insert(client, {
          id,
          name,
          slug: `root-walk-${id}`,
          createdBy: userId(),
        })
      }
      const owner = (await addTestMember(client, wsId, userId())).id
      const otherOwner = (await addTestMember(client, otherWsId, userId())).id

      for (const [id, ws, createdBy] of [
        [sealedId, wsId, owner],
        [plainId, wsId, owner],
        [otherWsPlainId, otherWsId, otherOwner],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.SCRATCHPAD,
          createdBy,
        })
      }

      for (const [id, rootId] of [
        [sealedThreadId, sealedId],
        [plainThreadId, plainId],
      ] as const) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: wsId,
          type: StreamTypes.THREAD,
          parentStreamId: rootId,
          rootStreamId: rootId,
          createdBy: owner,
        })
      }

      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: sealedId,
        workspaceId: wsId,
        ownerUserId: owner,
        ownerUserKeyId: "e2ek_owner",
      })
    })

    return { wsId, sealedId, sealedThreadId, plainId, plainThreadId, otherWsPlainId }
  }

  test("should drop a thread under an E2E root that carries no e2e_streams row of its own", async () => {
    const { wsId, sealedId, sealedThreadId, plainId, plainThreadId, otherWsPlainId } = await seed()

    const reportable = await E2eStreamsRepository.excludeE2eRootedStreamIds(pool, wsId, [
      sealedId,
      sealedThreadId,
      plainId,
      plainThreadId,
      otherWsPlainId,
      streamId(),
    ])

    expect(new Set(reportable)).toEqual(new Set([plainId, plainThreadId]))
  })

  test("should return nothing when no ids are given", async () => {
    const { wsId } = await seed()

    expect(await E2eStreamsRepository.excludeE2eRootedStreamIds(pool, wsId, [])).toEqual([])
  })
})
