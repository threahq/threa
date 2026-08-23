/**
 * Anchor sharing across stream types, unlocked by the untyped-index drop in
 * this layer: anchor uniqueness is a THREAD invariant only, so several asides
 * may sit on one message and a thread on that message is still the one thread.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { userId, workspaceId, messageId } from "../../src/lib/id"
import { StreamTypes } from "@threa/types"

describe("Aside cross-type anchor sharing (post index drop)", () => {
  let pool: Pool
  let streamService: StreamService
  let wsId: string
  let creator: string
  let sequence = 1n

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      creator = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Aside Anchor Test Workspace",
        slug: `aside-anchor-ws-${wsId.toLowerCase()}`,
        createdBy: creator,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function insertMessage(streamId: string, authorId: string): Promise<string> {
    const id = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id,
        streamId,
        sequence: sequence++,
        authorId,
        authorType: "user",
        ...testMessageContent("host message"),
      })
    })
    return id
  }

  test("multiple asides share an anchor; a thread on the same anchor is a real thread", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: "aside-shared-anchor",
      visibility: "public",
      createdBy: creator,
    })
    const anchorId = await insertMessage(channel.id, creator)

    const first = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    const second = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    expect(second.id).not.toBe(first.id)
    expect(second.type).toBe(StreamTypes.ASIDE)

    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    expect(thread.type).toBe(StreamTypes.THREAD)
    expect([first.id, second.id]).not.toContain(thread.id)

    // The drop narrows anchor uniqueness to threads; it does not remove it.
    const sameThread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    expect(sameThread.id).toBe(thread.id)

    const threadsByAnchor = await StreamRepository.findThreadsForMessages(pool, channel.id)
    expect(threadsByAnchor.get(anchorId)).toBe(thread.id)
  })

  test("an aside opens on a message that already carries a thread", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: "aside-after-thread",
      visibility: "public",
      createdBy: creator,
    })
    const anchorId = await insertMessage(channel.id, creator)

    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    expect(aside.type).toBe(StreamTypes.ASIDE)
    expect(aside.id).not.toBe(thread.id)
  })

  test("moving a message takes its thread along and leaves its aside with the host", async () => {
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: "aside-move-stays",
      visibility: "public",
      createdBy: creator,
    })
    const anchorId = await insertMessage(channel.id, creator)
    const destinationAnchor = await insertMessage(channel.id, creator)
    const thread = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })
    const aside = await streamService.createAside({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: creator,
    })
    const destination = await streamService.createThread({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: destinationAnchor,
      createdBy: creator,
      principal: { kind: "user", userId: creator },
    })

    await withTransaction(pool, (client) =>
      StreamRepository.moveChildThreadsToParent(client, {
        workspaceId: wsId,
        sourceParentStreamId: channel.id,
        destinationParentStreamId: destination.id,
        parentMessageIds: [anchorId],
      })
    )

    expect((await StreamRepository.findById(pool, thread.id))?.parentStreamId).toBe(destination.id)
    expect((await StreamRepository.findById(pool, aside.id))?.parentStreamId).toBe(channel.id)
  })
})
