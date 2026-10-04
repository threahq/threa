/**
 * The readers of memo content pass who reads them. Every case uses ONE agent memo located in a
 * stream the reader can browse but sourced from streams the reader cannot read, so a reader that
 * only checks location (the pre-gate behaviour) returns it and one that passes its audience does
 * not. Real rows, real statements (INV-68).
 *
 * `loc` is guest_public, so a guest passes the location filter for every memo here.
 */

import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthoredByKinds, StreamTypes, Visibilities, type Visibility } from "@threahq/types"
import { PreparedRecall, memoAudienceForSpec } from "../../src/features/agents"
import {
  MemoExplorerService,
  MemoRepository,
  createMemoHandlers,
  StubEmbeddingService,
  StubReranker,
  type MemoAudience,
} from "../../src/features/memos"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { createStreamContextService, StreamContextRepository } from "../../src/features/stream-context"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { memoId, messageId, streamContextItemId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const TOKEN = "zephyrquartz"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

describe("memo readers pass their audience", () => {
  let pool: Pool
  let ws: string
  let member: string
  let guest: string

  const stream = {
    loc: streamId(),
    pub: streamId(),
    priv: streamId(),
    roomGuest: streamId(),
    roomAll: streamId(),
    roomGuestThread: streamId(),
  }

  const memos = {} as Record<"visible" | "leaksPublic" | "leaksPrivate", string>
  const labelOf = (id: string) => Object.entries(memos).find(([, memo]) => memo === id)?.[0] ?? id
  const labels = (ids: string[]) => ids.map(labelOf).sort()

  let explorer: MemoExplorerService
  let sequence = 1n

  async function seedMemo(label: keyof typeof memos, sources: string[]): Promise<void> {
    const id = memoId()
    const msgId = messageId()
    memos[label] = id
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        workspaceId: ws,
        id: msgId,
        streamId: stream.loc,
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
        sourceStreamIds: sources,
      })
      await MemoRepository.updateEmbedding(client, ws, id, axis(0))
    })
  }

  const permissionsFor = (audience: MemoAudience, viewer: string) => ({
    accessibleStreamIds: [stream.loc],
    userId: viewer,
    audiences: [audience],
  })

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ws = workspaceId()
    const owner = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Memo Readers",
        slug: `memo-readers-${ws}`,
        createdBy: owner,
      })
      member = (await addTestMember(client, ws, owner)).id
      guest = (await addTestMember(client, ws, userId(), "guest")).id

      const channels: [string, Visibility][] = [
        [stream.loc, Visibilities.GUEST_PUBLIC],
        [stream.pub, Visibilities.PUBLIC],
        [stream.priv, Visibilities.PRIVATE],
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
      await StreamRepository.insert(client, {
        id: stream.roomGuestThread,
        workspaceId: ws,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: stream.roomGuest,
        rootStreamId: stream.roomGuest,
        createdBy: member,
      })
      const memberships: [string, string][] = [
        [stream.priv, member],
        [stream.roomGuest, member],
        [stream.roomGuest, guest],
        [stream.roomAll, member],
      ]
      for (const [roomId, memberId] of memberships) {
        await StreamMemberRepository.insert(client, ws, roomId, memberId)
      }
    })

    await seedMemo("visible", [stream.loc])
    await seedMemo("leaksPublic", [stream.pub])
    await seedMemo("leaksPrivate", [stream.priv])

    explorer = new MemoExplorerService({
      pool,
      embeddingService: new StubEmbeddingService(),
      reranker: new StubReranker(),
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should hide a memo from a guest in search and by id while a member gets it", async () => {
    const guestAudience: MemoAudience = { kind: "users", userIds: [guest] }
    const memberAudience: MemoAudience = { kind: "users", userIds: [member] }
    const search = (audience: MemoAudience, viewer: string) =>
      explorer.search({
        workspaceId: ws,
        permissions: permissionsFor(audience, viewer),
        query: TOKEN,
        embedding: axis(0),
        mode: "fast",
        semanticDistanceThreshold: null,
      })
    const detail = async (audience: MemoAudience, viewer: string) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(memos).map(async ([label, id]) => [
            label,
            (await explorer.getById(ws, id, permissionsFor(audience, viewer)))?.memo.id === id,
          ])
        )
      )

    const [guestHits, memberHits, guestDetail, memberDetail] = await Promise.all([
      search(guestAudience, guest),
      search(memberAudience, member),
      detail(guestAudience, guest),
      detail(memberAudience, member),
    ])

    expect({
      guestHits: labels(guestHits.map((hit) => hit.memo.id)),
      memberHits: labels(memberHits.map((hit) => hit.memo.id)),
      guestDetail,
      memberDetail,
    }).toEqual({
      guestHits: ["visible"],
      memberHits: ["leaksPrivate", "leaksPublic", "visible"],
      guestDetail: { visible: true, leaksPublic: false, leaksPrivate: false },
      memberDetail: { visible: true, leaksPublic: true, leaksPrivate: true },
    })
  })

  test("should recall for a room only what every reader of the room can read", async () => {
    const recall = new PreparedRecall({
      memoExplorerService: explorer,
      scorer: { score: async (_query, candidates) => candidates.map(() => 1) },
      analyticsReporter: new DisabledAnalyticsReporter(),
    })
    const recallFor = async (roomStreamId: string) => {
      const result = await recall.recall({
        workspaceId: ws,
        invokingUserId: member,
        surface: "companion",
        query: TOKEN,
        accessibleStreamIds: new Set([stream.loc]),
        memoViewerUserId: undefined,
        memoAudience: memoAudienceForSpec({ type: "room_readable", roomStreamId }),
        asker: undefined,
      })
      return labels(result.memos.map((memo) => memo.id))
    }

    const [guestRoom, memberRoom] = await Promise.all([recallFor(stream.roomGuest), recallFor(stream.roomAll)])

    expect({ guestRoom, memberRoom }).toEqual({
      guestRoom: ["visible"],
      memberRoom: ["leaksPublic", "visible"],
    })
  })

  test("should list a memo landmark in a room only when the room can read the memo's sources", async () => {
    const service = createStreamContextService({ pool })
    const landmarks = Object.values(memos).flatMap((id) =>
      [stream.roomGuest, stream.roomAll].map((room) => ({
        id: streamContextItemId(),
        workspaceId: ws,
        streamId: room,
        rootStreamId: room,
        category: "memo" as const,
        refKind: "memo" as const,
        refId: id,
        groupKey: id,
        sourceMessageId: null,
        authorId: member,
        occurredAt: new Date(),
        sequence: null,
        snippet: "memo",
        detail: {},
      }))
    )
    await StreamContextRepository.insertMany(pool, landmarks)

    const feed = async (room: string) => {
      const response = await service.list({
        workspaceId: ws,
        userId: member,
        streamId: room,
        scope: "tree",
        category: "memo",
        limit: 40,
      })
      return { shown: labels(response.items.map((item) => item.refId)), counted: response.counts?.memo }
    }

    const [guestRoom, memberRoom] = await Promise.all([feed(stream.roomGuest), feed(stream.roomAll)])

    expect({ guestRoom, memberRoom }).toEqual({
      guestRoom: { shown: ["visible"], counted: 1 },
      memberRoom: { shown: ["leaksPublic", "visible"], counted: 2 },
    })
  })

  test("should gate a thread's memo landmarks by the room of its root when the thread is not a member stream", async () => {
    const service = createStreamContextService({ pool })
    await StreamContextRepository.insertMany(
      pool,
      Object.values(memos).map((id) => ({
        id: streamContextItemId(),
        workspaceId: ws,
        streamId: stream.roomGuestThread,
        rootStreamId: stream.roomGuest,
        category: "memo" as const,
        refKind: "memo" as const,
        refId: id,
        groupKey: id,
        sourceMessageId: null,
        authorId: member,
        occurredAt: new Date(),
        sequence: null,
        snippet: "memo",
        detail: {},
      }))
    )

    const response = await service.list({
      workspaceId: ws,
      userId: member,
      streamId: stream.roomGuestThread,
      scope: "stream",
      category: "memo",
      limit: 40,
    })

    expect(labels(response.items.map((item) => item.refId))).toEqual(["visible"])
  })

  test("should hide from an anchored memo search what the anchor room cannot read when the member could", async () => {
    const handlers = createMemoHandlers({ pool, memoExplorerService: explorer })
    const search = async (anchorStreamId?: string) => {
      let sent: { results: Array<{ memo: { id: string } }> } | undefined
      const res = {
        locals: {},
        json: (body: typeof sent) => {
          sent = body
        },
      } as unknown as Response
      const req = {
        user: { id: member },
        workspaceId: ws,
        body: { query: TOKEN, exact: true, anchorStreamId },
      } as unknown as Request
      await handlers.search(req, res)
      return labels((sent?.results ?? []).map((result) => result.memo.id))
    }

    const [anchored, unanchored] = await Promise.all([search(stream.roomGuest), search()])

    expect({ anchored, unanchored }).toEqual({
      anchored: ["visible"],
      unanchored: ["leaksPrivate", "leaksPublic", "visible"],
    })
  })
})
