import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { StreamRepository } from "../../src/features/streams"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase } from "./setup"

describe("StreamRepository shared copy lookups", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function insertChannel(wsId: string, originWorkspaceId: string | null) {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      slug: `copy-refs-${id}`,
      originWorkspaceId,
      createdBy: userId(),
    })
    return id
  }

  test("should return only refs naming a copy in their own workspace when refs span workspaces", async () => {
    const wsA = workspaceId()
    const wsB = workspaceId()
    const copyA = await insertChannel(wsA, workspaceId())
    const localA = await insertChannel(wsA, null)
    const copyB = await insertChannel(wsB, workspaceId())

    const refs = await StreamRepository.findSharedCopyRefs(pool, [
      { workspaceId: wsA, streamId: copyA },
      { workspaceId: wsA, streamId: localA },
      { workspaceId: wsA, streamId: copyB },
      { workspaceId: wsB, streamId: copyB },
      { workspaceId: wsB, streamId: streamId() },
    ])

    expect(refs.sort((a, b) => a.streamId.localeCompare(b.streamId))).toEqual(
      [
        { workspaceId: wsA, streamId: copyA },
        { workspaceId: wsB, streamId: copyB },
      ].sort((a, b) => a.streamId.localeCompare(b.streamId))
    )
  })

  test("should say a stream is a shared copy only in the workspace that holds it", async () => {
    const wsA = workspaceId()
    const copy = await insertChannel(wsA, workspaceId())
    const local = await insertChannel(wsA, null)

    const answers = {
      copy: await StreamRepository.isSharedCopy(pool, wsA, copy),
      local: await StreamRepository.isSharedCopy(pool, wsA, local),
      otherWorkspace: await StreamRepository.isSharedCopy(pool, workspaceId(), copy),
    }

    expect(answers).toEqual({ copy: true, local: false, otherWorkspace: false })
  })
})
