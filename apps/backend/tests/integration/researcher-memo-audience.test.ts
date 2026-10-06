/**
 * The researcher's memo search carries the invocation's audience into the memo query. It runs the
 * real `WorkspaceAgent.search` (access spec, accessible streams, baseline memo query) against the
 * test schema; only the planner model and the embedding model are stubbed.
 *
 * `roomGuest` holds a guest, so its readers do not all browse; `roomAll` holds only members.
 * Both memos sit in a guest-public channel with readable sources, so only `requires_browse`
 * tells them apart.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthoredByKinds, StreamTypes, Visibilities, type Visibility } from "@threahq/types"
import type { AI } from "@threahq/agent-runtime"
import { WorkspaceAgent } from "../../src/features/agents/researcher"
import type { ConfigResolver } from "../../src/lib/ai/config-resolver"
import { MemoRepository, type EmbeddingServiceLike } from "../../src/features/memos"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { memoId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const TOKEN = "quillfernwick"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

describe("WorkspaceAgent memo search audience", () => {
  let pool: Pool
  let ws: string
  let member: string
  let guest: string
  let agent: WorkspaceAgent

  const stream = {
    gp: streamId(),
    roomGuest: streamId(),
    roomAll: streamId(),
    guestPad: streamId(),
    memberPad: streamId(),
  }
  let sequence = 1n

  async function seedMemo(label: string, requiresBrowse: boolean): Promise<void> {
    const id = memoId()
    const msgId = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        workspaceId: ws,
        id: msgId,
        streamId: stream.gp,
        sequence: sequence++,
        authorId: member,
        authorType: "user",
        ...testMessageContent("source"),
      })
      await MemoRepository.insert(client, {
        id,
        workspaceId: ws,
        memoType: "message",
        sourceMessageId: msgId,
        title: `${TOKEN} ${label}`,
        abstract: "abstract",
        keyPoints: [],
        sourceMessageIds: [msgId],
        participantIds: [member],
        knowledgeType: "decision",
        tags: [],
        status: "active",
        authoredByKind: AuthoredByKinds.AGENT,
        sourceStreamIds: [stream.gp],
        requiresBrowse,
      })
      await MemoRepository.updateEmbedding(client, ws, id, axis(0))
    })
  }

  async function memoLabelsFoundIn(invocationStreamId: string, invokingUserId: string): Promise<string[]> {
    const result = await agent.search({
      workspaceId: ws,
      streamId: invocationStreamId,
      query: TOKEN,
      conversationHistory: [],
      invokingUserId,
      searchFlag: "off",
    })
    return result.memos.map((found) => found.memo.title.replace(`${TOKEN} `, "")).sort()
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ws = workspaceId()
    const owner = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Researcher Memo Audience",
        slug: `researcher-memo-audience-${ws}`,
        createdBy: owner,
      })
      member = (await addTestMember(client, ws, owner)).id
      guest = (await addTestMember(client, ws, userId(), "guest")).id

      const channels: [string, Visibility][] = [
        [stream.gp, Visibilities.GUEST_PUBLIC],
        [stream.roomGuest, Visibilities.PRIVATE],
        [stream.roomAll, Visibilities.PRIVATE],
      ]
      for (const [id, visibility] of channels) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.CHANNEL,
          visibility,
          slug: `s-${id.slice(-8)}`,
          createdBy: member,
        })
      }
      const pads: [string, string][] = [
        [stream.guestPad, guest],
        [stream.memberPad, member],
      ]
      for (const [id, ownerId] of pads) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: StreamTypes.SCRATCHPAD,
          visibility: Visibilities.PRIVATE,
          createdBy: ownerId,
        })
      }
      const memberships: [string, string][] = [
        [stream.roomGuest, member],
        [stream.roomGuest, guest],
        [stream.roomAll, member],
        [stream.guestPad, guest],
        [stream.memberPad, member],
      ]
      for (const [roomId, memberId] of memberships) {
        await StreamMemberRepository.insert(client, ws, roomId, memberId)
      }
    })

    await seedMemo("open", false)
    await seedMemo("browseOnly", true)

    const planner = { reasoning: "stub", queries: [] }
    agent = new WorkspaceAgent({
      pool,
      ai: {} as AI,
      configResolver: { resolve: async () => ({}) } as unknown as ConfigResolver,
      embeddingService: { embed: async () => axis(0) } as unknown as EmbeddingServiceLike,
    })
    ;(agent as unknown as { planRetrieval: () => Promise<typeof planner> }).planRetrieval = async () => planner
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should withhold a browse-requiring agent memo when the room holds a reader who cannot browse", async () => {
    const [guestRoom, memberRoom] = await Promise.all([
      memoLabelsFoundIn(stream.roomGuest, member),
      memoLabelsFoundIn(stream.roomAll, member),
    ])

    expect({ guestRoom, memberRoom }).toEqual({
      guestRoom: ["open"],
      memberRoom: ["browseOnly", "open"],
    })
  })

  test("should withhold a browse-requiring agent memo when the invoker alone is the audience and cannot browse", async () => {
    const [guestPad, memberPad] = await Promise.all([
      memoLabelsFoundIn(stream.guestPad, guest),
      memoLabelsFoundIn(stream.memberPad, member),
    ])

    expect({ guestPad, memberPad }).toEqual({
      guestPad: ["open"],
      memberPad: ["browseOnly", "open"],
    })
  })
})
