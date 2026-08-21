import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { AI } from "@threa/agent-runtime"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import {
  assertRefAccess,
  resolveBagForStream,
  fetchStreamBag,
  VIEWPORT_WINDOW_PAD,
  VIEWPORT_WINDOW_TOTAL,
} from "../../src/features/agents"
import { userId, workspaceId, messageId, conversationId } from "../../src/lib/id"
import { ContextIntents, ContextRefKinds, type ContextRef, type Stream, type ViewportContextRef } from "@threa/types"

describe("Aside viewport snapshot", () => {
  let pool: Pool
  let streamService: StreamService
  let wsId: string
  let creator: string
  let other: string
  let sequence = 1n
  // Never invoked: the aside intent inlines the bounded window, so no summarizer runs.
  const ai = {} as AI

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      creator = (await addTestMember(client, wsId, userId())).id
      other = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Aside Viewport Test Workspace",
        slug: `aside-viewport-ws-${wsId.toLowerCase()}`,
        createdBy: creator,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function createChannel(
    slug: string,
    visibility: "public" | "private",
    memberIds: string[] = []
  ): Promise<Stream> {
    return streamService.createChannel({ workspaceId: wsId, slug, visibility, createdBy: creator, memberIds })
  }

  async function insertMessages(streamId: string, authorId: string, count: number): Promise<string[]> {
    const ids: string[] = []
    await withTransaction(pool, async (client) => {
      for (let i = 0; i < count; i++) {
        const id = messageId()
        await MessageRepository.insert(client, {
          id,
          streamId,
          sequence: sequence++,
          authorId,
          authorType: "user",
          ...testMessageContent(`message ${i}`),
        })
        ids.push(id)
      }
    })
    return ids
  }

  function viewportRef(streamId: string, visibleMessageIds: string[]): ViewportContextRef {
    return { kind: ContextRefKinds.VIEWPORT, streamId, visibleMessageIds, capturedAt: new Date().toISOString() }
  }

  async function createAsideWithBag(
    parentStreamId: string,
    refs: ContextRef[],
    parentAnchorId?: string
  ): Promise<Stream> {
    return streamService.createAside({
      workspaceId: wsId,
      parentStreamId,
      parentAnchorId,
      createdBy: creator,
      contextBag: { intent: ContextIntents.ASIDE, refs },
    })
  }

  async function resolve(asideId: string) {
    const resolved = await resolveBagForStream(
      { pool, ai, costContext: { workspaceId: wsId, origin: "system" } },
      asideId
    )
    expect(resolved).not.toBeNull()
    return resolved!
  }

  test("visible ids expand to the padded sibling window and the on-screen span is marked", async () => {
    const channel = await createChannel("viewport-expand", "public")
    const ids = await insertMessages(channel.id, other, 40)
    const visible = ids.slice(15, 19)

    const aside = await createAsideWithBag(channel.id, [viewportRef(channel.id, visible)], visible[0])
    const resolved = await resolve(aside.id)

    expect(resolved.intent).toBe(ContextIntents.ASIDE)
    expect(resolved.refs).toHaveLength(1)
    expect(resolved.refs[0].items.map((m) => m.messageId)).toEqual(
      ids.slice(15 - VIEWPORT_WINDOW_PAD, 19 + VIEWPORT_WINDOW_PAD)
    )
    expect(resolved.refs[0].source.itemCount).toBe(4 + 2 * VIEWPORT_WINDOW_PAD)

    expect(resolved.stable).toContain("## Context source: viewport:" + channel.id)
    expect(resolved.stable).toContain(`Messages before what was on screen (${VIEWPORT_WINDOW_PAD}, chronological):`)
    expect(resolved.stable).toContain("On screen when the aside was opened (captured ")
    expect(resolved.stable).toContain("; 4 visible, chronological;")
    for (const id of visible) expect(resolved.stable).toContain(`► [${id}]`)
    expect(resolved.stable).toContain(`Messages after what was on screen (${VIEWPORT_WINDOW_PAD}, chronological):`)
    expect(resolved.stable).toContain(`- [${ids[14]}]`)
    expect(resolved.stable).toContain(`- [${ids[19]}]`)
    expect(resolved.stable).not.toContain(`[${ids[4]}]`)
    expect(resolved.stable).not.toContain(`[${ids[29]}]`)
  })

  test("the window is hard-capped at VIEWPORT_WINDOW_TOTAL", async () => {
    const channel = await createChannel("viewport-cap", "public")
    const ids = await insertMessages(channel.id, other, VIEWPORT_WINDOW_TOTAL + 30)
    // A span wider than the cap minus its leading pad: the trailing pad and
    // the span's own tail are what get cut, the lead-in survives.
    const visible = [ids[5], ids[VIEWPORT_WINDOW_TOTAL + 10]]

    const aside = await createAsideWithBag(channel.id, [viewportRef(channel.id, visible)])
    const resolved = await resolve(aside.id)

    const rendered = resolved.refs[0].items.map((m) => m.messageId)
    expect(rendered).toHaveLength(VIEWPORT_WINDOW_TOTAL)
    expect(rendered).toEqual(ids.slice(0, VIEWPORT_WINDOW_TOTAL))
    expect(resolved.stable).toContain(`► [${ids[5]}]`)
  })

  test("a deleted visible id drops out; with none left the ref is omitted for agent and chip alike", async () => {
    const channel = await createChannel("viewport-deleted", "public")
    const ids = await insertMessages(channel.id, other, 20)
    await withTransaction(pool, (client) => MessageRepository.softDelete(client, ids[10]))

    const aside = await createAsideWithBag(channel.id, [viewportRef(channel.id, [ids[10], ids[11]])])
    const resolved = await resolve(aside.id)
    expect(resolved.stable).toContain("; 1 visible,")
    expect(resolved.stable).toContain(`► [${ids[11]}]`)
    expect(resolved.stable).not.toContain(`[${ids[10]}]`)
    const chip = await fetchStreamBag(pool, { workspaceId: wsId, streamId: aside.id, userId: creator })
    expect(chip.refs.map((r) => r.source.itemCount)).toEqual([resolved.refs[0].items.length])

    const orphaned = await createAsideWithBag(channel.id, [viewportRef(channel.id, [ids[10]])])
    const gone = await resolve(orphaned.id)
    expect(gone.refs).toEqual([])
    expect(gone.stable).toBe("")
    const goneChip = await fetchStreamBag(pool, { workspaceId: wsId, streamId: orphaned.id, userId: creator })
    expect(goneChip).toMatchObject({ bag: { intent: ContextIntents.ASIDE }, refs: [] })
  })

  test("a viewport of a thread inside a member channel resolves through the root for a non-member of the thread (INV-62)", async () => {
    const channel = await createChannel("viewport-thread", "public", [other])
    const [anchorId] = await insertMessages(channel.id, other, 1)
    const thread = await streamService.createThreadInternal({
      workspaceId: wsId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: other,
    })
    const replies = await insertMessages(thread.id, other, 5)

    // The thread is the host (a first-class aside host); the creator is a channel
    // member but never joined the thread.
    const aside = await createAsideWithBag(thread.id, [viewportRef(thread.id, replies.slice(2, 4))])
    const resolved = await resolve(aside.id)

    expect(resolved.refs).toHaveLength(1)
    expect(resolved.refs[0].items.map((m) => m.messageId)).toEqual([anchorId, ...replies])
    expect(resolved.stable).toContain(`- [${anchorId}]`)
    expect(resolved.stable).toContain(`► [${replies[2]}]`)
  })

  test("a ref to a stream the creator lost access to drops out; the others survive", async () => {
    // Host = private channel (viewport ref); the bag also carries a conversation
    // ref from a public channel, the shape a board-opened aside produces.
    const privateChannel = await createChannel("viewport-private", "private", [other])
    const publicChannel = await createChannel("viewport-public", "public")
    const privateIds = await insertMessages(privateChannel.id, other, 3)
    const publicIds = await insertMessages(publicChannel.id, other, 3)
    const convId = conversationId()
    await withTransaction(pool, async (client) => {
      await ConversationRepository.insert(client, { id: convId, streamId: publicChannel.id, workspaceId: wsId })
      await ConversationRepository.addPrimaryMessages(client, wsId, convId, publicIds, [other])
    })

    const aside = await createAsideWithBag(privateChannel.id, [
      viewportRef(privateChannel.id, privateIds),
      { kind: ContextRefKinds.CONVERSATION, conversationId: convId, streamId: publicChannel.id },
    ])
    const before = await resolve(aside.id)
    expect(before.refs.map((r) => r.streamId)).toEqual([privateChannel.id, publicChannel.id])

    await streamService.removeMember(privateChannel.id, creator, wsId, other)

    const after = await resolve(aside.id)
    expect(after.refs.map((r) => r.streamId)).toEqual([publicChannel.id])
    expect(after.stable).not.toContain(privateIds[0])
    expect(after.stable).toContain(`[${publicIds[0]}]`)

    const chip = await fetchStreamBag(pool, { workspaceId: wsId, streamId: aside.id, userId: creator })
    expect(chip.refs.map((r) => r.streamId)).toEqual([publicChannel.id])
  })

  test("an aside on a host the creator cannot read is rejected at create time; the resolver refuses its viewport too", async () => {
    const privateChannel = await streamService.createChannel({
      workspaceId: wsId,
      slug: "viewport-foreign",
      visibility: "private",
      createdBy: other,
      memberIds: [],
    })
    const foreignIds = await insertMessages(privateChannel.id, other, 2)

    // The viewport ref is bound to the host (create-contract refinement), so
    // host access is the ref's access: the create transaction rejects it.
    await expect(
      createAsideWithBag(privateChannel.id, [viewportRef(privateChannel.id, foreignIds)])
    ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" })
    await expect(
      assertRefAccess(pool, viewportRef(privateChannel.id, foreignIds), creator, wsId)
    ).rejects.toMatchObject({ status: 403, code: "CONTEXT_SOURCE_FORBIDDEN" })
  })
})
