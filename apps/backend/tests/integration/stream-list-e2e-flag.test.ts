/**
 * A stream list has to report sealed-ness, not only a single-stream read.
 *
 * The public API's `e2eEnabled` is what a client checks before it composes a
 * message, so a list that omitted it would tell a caller a sealed stream is
 * plaintext — and the plaintext body would reach the server once before the
 * write gate rejected it. `listByIds` only carries the flag while its query
 * joins `e2e_streams`, which is what this pins.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { userId, workspaceId, streamId } from "../../src/lib/id"

describe("StreamRepository.listByIds and end-to-end encryption", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seed(): Promise<{ wsId: string; sealedId: string; plainId: string }> {
    const wsId = workspaceId()
    const sealedId = streamId()
    const plainId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Stream List WS",
        slug: `stream-list-${wsId}`,
        createdBy: userId(),
      })
      const owner = (await addTestMember(client, wsId, userId())).id

      for (const id of [sealedId, plainId]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: wsId,
          type: StreamTypes.SCRATCHPAD,
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

    return { wsId, sealedId, plainId }
  }

  test("should report a sealed stream as e2eEnabled and leave a plaintext one unflagged", async () => {
    const { wsId, sealedId, plainId } = await seed()

    const listed = await StreamRepository.listByIds(pool, wsId, [sealedId, plainId])

    expect(new Map(listed.map((s) => [s.id, s.e2eEnabled]))).toEqual(
      new Map([
        [sealedId, true],
        [plainId, undefined],
      ])
    )
  })

  test("should agree with a single-stream read about the same stream", async () => {
    const { wsId, sealedId } = await seed()

    const [listed] = await StreamRepository.listByIds(pool, wsId, [sealedId])
    const read = await StreamRepository.findByIdForWorkspace(pool, sealedId, wsId)

    expect(listed?.e2eEnabled).toBe(true)
    expect(listed?.e2eEnabled).toBe(read?.e2eEnabled)
  })
})
