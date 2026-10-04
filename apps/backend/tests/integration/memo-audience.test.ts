/**
 * `memoAudienceVisibleSql` — the provenance gate between an agent-authored memo and the people it
 * is shown to. An agent memo is written from streams its location does not reveal, so each
 * audience must be able to read every stream in `source_stream_ids`. Every case seeds real rows
 * and reads back what the statement returns (INV-68).
 *
 * Streams: `gp` (guest_public) with a thread, `pub` (public), `priv` (member-only). `roomGuest`
 * holds a guest, `roomAll` only members. Memos are labelled by their provenance.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AuthoredByKinds, StreamTypes, Visibilities, type Visibility } from "@threahq/types"
import { audienceBrowses, MemoRepository, type MemoAudience } from "../../src/features/memos"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { memoId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const TOKEN = "zephyrquartz"

function axis(index: number): number[] {
  const vector = new Array(1536).fill(0)
  vector[index] = 1
  return vector
}

describe("memoAudienceVisibleSql", () => {
  let pool: Pool
  let ws: string
  let member: string
  let outsider: string
  let guest: string

  const stream = {
    loc: streamId(),
    gp: streamId(),
    gpThread: streamId(),
    pub: streamId(),
    priv: streamId(),
    privThread: streamId(),
    roomGuest: streamId(),
    roomAll: streamId(),
    missing: streamId(),
  }

  const memos = {} as Record<string, string>
  let sequence = 1n

  async function seedMemo(
    label: string,
    options: {
      sources: string[] | null
      kind?: "agent" | "pipeline"
      locatedIn?: string
      tags?: string[]
      requiresBrowse?: boolean
    }
  ): Promise<void> {
    const id = memoId()
    const msgId = messageId()
    memos[label] = id
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        workspaceId: ws,
        id: msgId,
        streamId: options.locatedIn ?? stream.loc,
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
        tags: options.tags ?? [],
        status: "active",
        authoredByKind: options.kind === "pipeline" ? AuthoredByKinds.PIPELINE : AuthoredByKinds.AGENT,
        ...(options.sources ? { sourceStreamIds: options.sources } : {}),
        requiresBrowse: options.requiresBrowse,
      })
      await MemoRepository.updateEmbedding(client, ws, id, axis(0))
    })
  }

  const labelOf = (id: string) => Object.entries(memos).find(([, memo]) => memo === id)?.[0] ?? id

  async function visibleTo(audiences: MemoAudience[]): Promise<string[]> {
    const visible = await MemoRepository.filterVisibleIds(pool, ws, Object.values(memos), audiences)
    return [...visible].map(labelOf).sort()
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    ws = workspaceId()
    const owner = userId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Memo Audience",
        slug: `memo-audience-${ws}`,
        createdBy: owner,
      })
      member = (await addTestMember(client, ws, owner)).id
      outsider = (await addTestMember(client, ws, userId())).id
      guest = (await addTestMember(client, ws, userId(), "guest")).id

      const channels: [string, Visibility][] = [
        [stream.loc, Visibilities.PRIVATE],
        [stream.gp, Visibilities.GUEST_PUBLIC],
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
        id: stream.gpThread,
        workspaceId: ws,
        type: StreamTypes.THREAD,
        visibility: Visibilities.GUEST_PUBLIC,
        parentStreamId: stream.gp,
        rootStreamId: stream.gp,
        createdBy: member,
      })
      await StreamRepository.insert(client, {
        id: stream.privThread,
        workspaceId: ws,
        type: StreamTypes.THREAD,
        visibility: Visibilities.PRIVATE,
        parentStreamId: stream.priv,
        rootStreamId: stream.priv,
        createdBy: member,
      })
      const memberships: [string, string][] = [
        [stream.loc, member],
        [stream.priv, member],
        [stream.roomGuest, member],
        [stream.roomGuest, guest],
        [stream.roomAll, member],
      ]
      for (const [roomId, memberId] of memberships) {
        await StreamMemberRepository.insert(client, ws, roomId, memberId)
      }
    })

    await seedMemo("gpOnly", { sources: [stream.gp] })
    await seedMemo("pubOnly", { sources: [stream.pub] })
    await seedMemo("privOnly", { sources: [stream.priv] })
    await seedMemo("mixed", { sources: [stream.gp, stream.pub] })
    await seedMemo("inThread", { sources: [stream.gpThread] })
    await seedMemo("inPrivThread", { sources: [stream.privThread] })
    await seedMemo("inRoomAll", { sources: [stream.roomAll] })
    await seedMemo("unknownStream", { sources: [stream.missing] })
    await seedMemo("legacyAgent", { sources: null })
    await seedMemo("pipeline", { sources: null, kind: "pipeline" })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should hide what a guest cannot read when the audience is users", async () => {
    const [forGuest, forMember, forOutsider, forBoth] = await Promise.all([
      visibleTo([{ kind: "users", userIds: [guest] }]),
      visibleTo([{ kind: "users", userIds: [member] }]),
      visibleTo([{ kind: "users", userIds: [outsider] }]),
      visibleTo([{ kind: "users", userIds: [member, guest] }]),
    ])

    expect({ forGuest, forMember, forOutsider, forBoth }).toEqual({
      forGuest: ["gpOnly", "inThread", "pipeline"],
      forMember: [
        "gpOnly",
        "inPrivThread",
        "inRoomAll",
        "inThread",
        "legacyAgent",
        "mixed",
        "pipeline",
        "privOnly",
        "pubOnly",
      ],
      forOutsider: ["gpOnly", "inThread", "legacyAgent", "mixed", "pipeline", "pubOnly"],
      forBoth: ["gpOnly", "inThread", "pipeline"],
    })
  })

  test("should show a legacy agent memo only to readers who browse when it records no sources", async () => {
    const [guestRoom, memberRoom, streams] = await Promise.all([
      visibleTo([{ kind: "room", roomStreamId: stream.roomGuest }]),
      visibleTo([{ kind: "room", roomStreamId: stream.roomAll }]),
      visibleTo([{ kind: "streams", streamIds: [stream.gp, stream.pub], browses: true }]),
    ])

    expect({ guestRoom, memberRoom, streams }).toEqual({
      guestRoom: ["gpOnly", "inThread", "pipeline"],
      memberRoom: ["gpOnly", "inRoomAll", "inThread", "legacyAgent", "mixed", "pipeline", "pubOnly"],
      streams: ["gpOnly", "inThread", "mixed", "pipeline", "pubOnly"],
    })
  })

  test("should apply no gate when there are no audiences", async () => {
    expect(await visibleTo([])).toEqual(Object.keys(memos).sort())
  })

  test("should return only the visible subset when filtering ids", async () => {
    const visible = await MemoRepository.filterVisibleIds(
      pool,
      ws,
      [memos.gpOnly, memos.privOnly, memos.pipeline, memoId()],
      [{ kind: "users", userIds: [guest] }]
    )
    const none = await MemoRepository.filterVisibleIds(pool, ws, [], [{ kind: "users", userIds: [guest] }])

    expect({ visible: [...visible].sort(), none: [...none] }).toEqual({
      visible: [memos.gpOnly, memos.pipeline].sort(),
      none: [],
    })
  })

  test("should gate every search method when an audience is given", async () => {
    const filters = { audiences: [{ kind: "users", userIds: [guest] }] satisfies MemoAudience[] }
    const [full, browse, exact, hybrid] = await Promise.all([
      MemoRepository.fullTextSearch(pool, { workspaceId: ws, query: TOKEN, filters, limit: 50 }),
      MemoRepository.fullTextSearch(pool, { workspaceId: ws, query: "", filters, limit: 50 }),
      MemoRepository.exactSearch(pool, { workspaceId: ws, query: TOKEN, filters, limit: 50 }),
      MemoRepository.hybridSearch(pool, {
        workspaceId: ws,
        query: TOKEN,
        embedding: axis(0),
        filters,
        limit: 50,
        semanticDistanceThreshold: null,
      }),
    ])
    const labels = (rows: { memo: { id: string } }[]) => rows.map((row) => labelOf(row.memo.id)).sort()

    expect({ full: labels(full), browse: labels(browse), exact: labels(exact), hybrid: labels(hybrid) }).toEqual({
      full: ["gpOnly", "inThread", "pipeline"],
      browse: ["gpOnly", "inThread", "pipeline"],
      exact: ["gpOnly", "inThread", "pipeline"],
      hybrid: ["gpOnly", "inThread", "pipeline"],
    })
  })

  test("should return nothing when the stream filter is an empty list", async () => {
    const filters = { streamIds: [] }
    const located = { streamIds: [stream.loc] }
    const [full, exact, hybrid, locatedFull] = await Promise.all([
      MemoRepository.fullTextSearch(pool, { workspaceId: ws, query: TOKEN, filters }),
      MemoRepository.exactSearch(pool, { workspaceId: ws, query: TOKEN, filters }),
      MemoRepository.hybridSearch(pool, {
        workspaceId: ws,
        query: TOKEN,
        embedding: axis(0),
        filters,
        semanticDistanceThreshold: null,
      }),
      MemoRepository.fullTextSearch(pool, { workspaceId: ws, query: TOKEN, filters: located, limit: 50 }),
    ])

    expect({
      full: full.map((row) => row.memo.id),
      exact: exact.map((row) => row.memo.id),
      hybrid: hybrid.map((row) => row.memo.id),
      locatedFound: locatedFull.some((row) => row.memo.id === memos.gpOnly),
    }).toEqual({ full: [], exact: [], hybrid: [], locatedFound: true })
  })

  test("should store the provenance deduped and sorted when inserting", async () => {
    await seedMemo("stored", { sources: [stream.pub, stream.gp, stream.pub] })

    const stored = await MemoRepository.findById(pool, ws, memos.stored)

    expect(stored?.sourceStreamIds).toEqual([stream.gp, stream.pub].sort())
  })

  test("should withhold a memo from a payload its citing room cannot read the sources of", async () => {
    await seedMemo("gpCitesPub", { sources: [stream.pub], locatedIn: stream.gp, tags: ["g5-gp-cites-pub"] })
    await seedMemo("gpCitesGp", { sources: [stream.gp], locatedIn: stream.gp, tags: ["g5-gp-cites-gp"] })
    await seedMemo("roomCitesPub", { sources: [stream.pub], locatedIn: stream.roomAll, tags: ["g5-room-cites-pub"] })

    const summaries = await MemoRepository.findEmbedSummariesByRoot(pool, ws, [
      { memoId: memos.gpCitesPub, citingRootStreamId: stream.gp },
      { memoId: memos.gpCitesGp, citingRootStreamId: stream.gp },
      { memoId: memos.roomCitesPub, citingRootStreamId: stream.roomAll },
    ])
    const [gpTags, roomTags] = await Promise.all([
      MemoRepository.getAllTags(pool, ws, { scopeUserId: null, rootStreamId: stream.gp }),
      MemoRepository.getAllTags(pool, ws, { scopeUserId: null, rootStreamId: stream.roomAll }),
    ])
    const cited = (root: string) => [...(summaries.get(root)?.keys() ?? [])].map(labelOf).sort()
    const gated = (tags: string[]) => tags.filter((tag) => tag.startsWith("g5-")).sort()

    expect({
      gp: cited(stream.gp),
      room: cited(stream.roomAll),
      gpTags: gated(gpTags),
      roomTags: gated(roomTags),
    }).toEqual({
      gp: ["gpCitesGp"],
      room: ["roomCitesPub"],
      gpTags: ["g5-gp-cites-gp"],
      roomTags: ["g5-gp-cites-gp", "g5-gp-cites-pub", "g5-room-cites-pub"],
    })
  })

  test("should hide a browse-requiring agent memo from audiences that cannot browse when its sources are readable", async () => {
    await seedMemo("gpRequiresBrowse", { sources: [stream.gp], requiresBrowse: true })
    await seedMemo("gpOpen", { sources: [stream.gp], requiresBrowse: false })
    const among = async (audiences: MemoAudience[]) => {
      const ids = [memos.gpRequiresBrowse, memos.gpOpen, memos.legacyAgent]
      return [...(await MemoRepository.filterVisibleIds(pool, ws, ids, audiences))].map(labelOf).sort()
    }
    const sources = [stream.gp]

    const [forGuest, forMember, guestRoom, memberRoom, browsingStreams, nonBrowsingStreams] = await Promise.all([
      among([{ kind: "users", userIds: [guest] }]),
      among([{ kind: "users", userIds: [member] }]),
      among([{ kind: "room", roomStreamId: stream.roomGuest }]),
      among([{ kind: "room", roomStreamId: stream.roomAll }]),
      among([{ kind: "streams", streamIds: sources, browses: true }]),
      among([{ kind: "streams", streamIds: sources, browses: false }]),
    ])

    expect({ forGuest, forMember, guestRoom, memberRoom, browsingStreams, nonBrowsingStreams }).toEqual({
      forGuest: ["gpOpen"],
      forMember: ["gpOpen", "gpRequiresBrowse", "legacyAgent"],
      guestRoom: ["gpOpen"],
      memberRoom: ["gpOpen", "gpRequiresBrowse", "legacyAgent"],
      browsingStreams: ["gpOpen", "gpRequiresBrowse"],
      nonBrowsingStreams: ["gpOpen"],
    })
  })

  test("should report whether every reader browses the workspace when the audience is users, a room or streams", async () => {
    const [forMember, forGuest, forBoth, allMemberRoom, guestPublicRoom, browsingStreams, nonBrowsingStreams] =
      await Promise.all([
        audienceBrowses(pool, ws, { kind: "users", userIds: [member] }),
        audienceBrowses(pool, ws, { kind: "users", userIds: [guest] }),
        audienceBrowses(pool, ws, { kind: "users", userIds: [member, guest] }),
        audienceBrowses(pool, ws, { kind: "room", roomStreamId: stream.roomAll }),
        audienceBrowses(pool, ws, { kind: "room", roomStreamId: stream.gp }),
        audienceBrowses(pool, ws, { kind: "streams", streamIds: [], browses: true }),
        audienceBrowses(pool, ws, { kind: "streams", streamIds: [], browses: false }),
      ])

    expect({
      forMember,
      forGuest,
      forBoth,
      allMemberRoom,
      guestPublicRoom,
      browsingStreams,
      nonBrowsingStreams,
    }).toEqual({
      forMember: true,
      forGuest: false,
      forBoth: false,
      allMemberRoom: true,
      guestPublicRoom: false,
      browsingStreams: true,
      nonBrowsingStreams: false,
    })
  })
})
