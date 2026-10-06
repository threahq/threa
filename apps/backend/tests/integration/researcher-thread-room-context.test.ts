/**
 * The researcher reads a thread reply together with the post that opened its thread, and searches the room the
 * question was asked in on top of the workspace. It runs the real `WorkspaceAgent.search` against the test schema;
 * only the planner model and the embedding model are stubbed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import type { AI } from "@threahq/agent-runtime"
import { WorkspaceAgent } from "../../src/features/agents/researcher"
import type { ConfigResolver } from "../../src/lib/ai/config-resolver"
import type { EmbeddingServiceLike } from "../../src/features/memos"
import { MessageRepository, type Message } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent } from "./setup"

const TOKEN = "brambleshank"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

describe("WorkspaceAgent thread and room context", () => {
  let pool: Pool
  let ws: string
  let member: string
  let agent: WorkspaceAgent
  let sequence = 1n
  let minute = 0

  const stream = { launch: streamId(), thread: streamId(), busy: streamId(), room: streamId(), elsewhere: streamId() }
  const msg = {} as Record<"root" | "reply" | "chatter" | "roomHit" | "question", Message>

  async function post(streamIdValue: string, text: string): Promise<Message> {
    return MessageRepository.insert(pool, {
      id: messageId(),
      workspaceId: ws,
      streamId: streamIdValue,
      sequence: sequence++,
      authorId: member,
      authorType: "user",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, minute++)),
      ...testMessageContent(text),
    })
  }

  async function research(roomId: string, conversationHistory: Message[] = []) {
    return agent.search({
      workspaceId: ws,
      streamId: roomId,
      query: TOKEN,
      conversationHistory,
      invokingUserId: member,
      searchFlag: "on",
    })
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ws = workspaceId()
    const owner = userId()
    await WorkspaceRepository.insert(pool, {
      id: ws,
      name: "Researcher Thread Room",
      slug: `researcher-thread-room-${ws}`,
      createdBy: owner,
    })
    member = (await addTestMember(pool, ws, owner)).id

    for (const id of [stream.launch, stream.busy, stream.room, stream.elsewhere]) {
      await StreamRepository.insert(pool, {
        id,
        workspaceId: ws,
        type: StreamTypes.CHANNEL,
        visibility: Visibilities.PUBLIC,
        slug: `c-${id.slice(-8).toLowerCase()}`,
        createdBy: member,
      })
      await StreamMemberRepository.insert(pool, ws, id, member)
    }

    // The busy notes and the reply match the query on keywords and embedding, so those five fill the workspace-wide
    // limit; the room's messages match on embedding alone and rank below them.
    msg.roomHit = await post(stream.room, "The gardening budget came up here")
    msg.root = await post(stream.launch, "Kicking off the launch checklist")
    await StreamRepository.insert(pool, {
      id: stream.thread,
      workspaceId: ws,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PUBLIC,
      parentStreamId: stream.launch,
      parentAnchorId: msg.root.id,
      rootStreamId: stream.launch,
      createdBy: member,
    })
    const busy: Message[] = []
    for (let i = 0; i < 4; i++) busy.push(await post(stream.busy, `${TOKEN} busy note ${i}`))
    msg.reply = await post(stream.thread, `${TOKEN} is signed off`)
    msg.chatter = await post(stream.launch, "Lunch is at noon")
    msg.question = await post(stream.room, "What about that budget?")
    await MessageRepository.updateEmbeddings(pool, ws, [
      ...[...busy, msg.reply].map((m) => ({ id: m.id, embedding: axis(0), sourceHash: "t", expectedSourceHash: null })),
      ...[msg.roomHit, msg.question].map((m) => ({
        id: m.id,
        embedding: axis(1),
        sourceHash: "t",
        expectedSourceHash: null,
      })),
    ])

    const planner = { reasoning: "stub", queries: [] }
    agent = new WorkspaceAgent({
      pool,
      ai: {} as AI,
      configResolver: { resolve: async () => ({ maxIterations: 1 }) } as unknown as ConfigResolver,
      embeddingService: { embed: async () => axis(0) } as unknown as EmbeddingServiceLike,
    })
    ;(agent as unknown as { planRetrieval: () => Promise<typeof planner> }).planRetrieval = async () => planner
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a thread reply comes with the post that opened its thread, not the channel's latest messages", async () => {
    const result = await research(stream.elsewhere)
    const ids = new Set(result.messages.map((m) => m.id))
    const context = result.retrievedContext ?? ""

    expect({
      root: ids.has(msg.root.id),
      reply: ids.has(msg.reply.id),
      chatter: ids.has(msg.chatter.id),
      rootOpensThread:
        context.indexOf("started the thread") > -1 &&
        context.indexOf("started the thread") < context.indexOf("is signed off"),
      threadHeader: context.includes(`#### Thread in _c-${stream.launch.slice(-8).toLowerCase()}_`),
    }).toEqual({ root: true, reply: true, chatter: false, rootOpensThread: true, threadHeader: true })
  })

  test("the room the question was asked in is searched on its own and listed first, without the question itself", async () => {
    const [fromElsewhere, fromRoom] = await Promise.all([
      research(stream.elsewhere),
      research(stream.room, [msg.question]),
    ])
    const roomHit = fromRoom.messages.find((m) => m.id === msg.roomHit.id)
    const context = fromRoom.retrievedContext ?? ""

    expect({
      foundFromElsewhere: fromElsewhere.messages.some((m) => m.id === msg.roomHit.id),
      foundFromRoom: roomHit?.inCurrentRoom,
      questionRetrieved: fromRoom.messages.some((m) => m.id === msg.question.id),
      roomGroupFirst: context.indexOf("(the room this question was asked in)") < context.indexOf("#### Thread in"),
    }).toEqual({ foundFromElsewhere: false, foundFromRoom: true, questionRetrieved: false, roomGroupFirst: true })
  })
})
