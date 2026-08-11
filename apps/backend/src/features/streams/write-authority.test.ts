import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { HttpError } from "@threa/backend-common"
import { StreamErrorCodes, StreamReadOnlyReasons } from "@threa/types"
import type { Querier } from "../../db"
import { BotChannelAccessRepository } from "../api-keys"
import { StreamMemberRepository } from "./member-repository"
import { StreamRepository, type Stream } from "./repository"
import {
  assertViewerStreamWritable,
  deriveStreamViewerState,
  projectStreamForBot,
  projectStreamForUser,
  projectStreamsForBot,
  projectStreamsForUser,
} from "./write-authority"

const db = {} as Querier

function stream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_root",
    workspaceId: "ws_1",
    type: "channel",
    displayName: null,
    slug: null,
    description: null,
    descriptionJson: null,
    visibility: "public",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    replyCount: 0,
    lastReplyAt: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    archivedAt: null,
    ...overrides,
  }
}

afterEach(() => mock.restore())

describe("deriveStreamViewerState", () => {
  test("derives writable participation and every reason with fixed precedence", () => {
    const writable = stream()
    expect([
      deriveStreamViewerState({ target: writable, root: writable, participates: true }),
      deriveStreamViewerState({
        target: stream({ archivedAt: new Date(0), type: "system" }),
        root: writable,
        participates: false,
      }),
      deriveStreamViewerState({ target: writable, root: stream({ archivedAt: new Date(0) }), participates: true }),
      deriveStreamViewerState({ target: stream({ type: "system" }), root: writable, participates: false }),
      deriveStreamViewerState({ target: writable, root: writable, participates: false }),
    ]).toEqual([
      { readOnly: false, readOnlyReason: null },
      { readOnly: true, readOnlyReason: StreamReadOnlyReasons.ARCHIVED },
      { readOnly: true, readOnlyReason: StreamReadOnlyReasons.ARCHIVED },
      { readOnly: true, readOnlyReason: StreamReadOnlyReasons.SYSTEM_STREAM },
      { readOnly: true, readOnlyReason: StreamReadOnlyReasons.NOT_A_MEMBER },
    ])
  })
})

describe("viewer projection", () => {
  test("single public descendant without root membership is read-only", async () => {
    const root = stream({ id: "stream_public" })
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: root.id })
    spyOn(StreamRepository, "findById").mockResolvedValue(root)
    const membership = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    const result = await projectStreamForUser(db, { workspaceId: "ws_1", stream: thread, userId: "usr_1" })

    expect(result).toMatchObject({ id: thread.id, readOnly: true, readOnlyReason: "not_a_member" })
    expect(membership).toHaveBeenCalledWith(db, root.id, "usr_1")
  })

  test("single private descendant without root membership is inaccessible", async () => {
    const root = stream({ visibility: "private" })
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: root.id })
    spyOn(StreamRepository, "findById").mockResolvedValue(root)
    const membership = spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    expect(await projectStreamForUser(db, { workspaceId: "ws_1", stream: thread, userId: "usr_1" })).toBeNull()
    expect(membership).toHaveBeenCalledWith(db, root.id, "usr_1")
  })

  test("single bot descendant is writable when only its effective root is granted", async () => {
    const root = stream({ visibility: "private" })
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: root.id })
    spyOn(StreamRepository, "findById").mockResolvedValue(root)
    const grant = spyOn(BotChannelAccessRepository, "hasGrant").mockResolvedValue(true)

    expect(await projectStreamForBot(db, { workspaceId: "ws_1", stream: thread, botId: "bot_1" })).toMatchObject({
      id: thread.id,
      readOnly: false,
      readOnlyReason: null,
    })
    expect(grant).toHaveBeenCalledWith(db, "ws_1", "bot_1", root.id)
  })

  test("single dangling root is inaccessible", async () => {
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: "stream_missing" })
    spyOn(StreamRepository, "findById").mockResolvedValue(null)
    const membership = spyOn(StreamMemberRepository, "isMember")

    expect(await projectStreamForUser(db, { workspaceId: "ws_1", stream: thread, userId: "usr_1" })).toBeNull()
    expect(membership).not.toHaveBeenCalled()
  })

  test("uses effective-root user membership, preserves order, and does not mutate rows", async () => {
    const root = stream({ visibility: "private" })
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: root.id, visibility: "private" })
    const original = structuredClone(thread)
    spyOn(StreamRepository, "findByIdsInWorkspace").mockResolvedValue([root])
    const memberships = spyOn(StreamMemberRepository, "findByStreamsAndMember").mockResolvedValue([
      { streamId: root.id, memberId: "usr_1", notificationLevel: null, joinedAt: new Date(0) },
    ])

    const result = await projectStreamsForUser(db, {
      workspaceId: "ws_1",
      streams: [thread, root],
      userId: "usr_1",
    })

    expect(result.map(({ id, readOnly, readOnlyReason }) => ({ id, readOnly, readOnlyReason }))).toEqual([
      { id: thread.id, readOnly: false, readOnlyReason: null },
      { id: root.id, readOnly: false, readOnlyReason: null },
    ])
    expect(thread).toEqual(original)
    expect(memberships).toHaveBeenCalledWith(db, [root.id], "usr_1")
  })

  test("returns public nonparticipants as read-only and hides private nonparticipants", async () => {
    const publicRoot = stream({ id: "stream_public" })
    const privateRoot = stream({ id: "stream_private", visibility: "private" })
    const publicThread = stream({ id: "stream_thread", type: "thread", rootStreamId: publicRoot.id })
    const privateThread = stream({ id: "stream_private_thread", type: "thread", rootStreamId: privateRoot.id })
    spyOn(StreamRepository, "findByIdsInWorkspace").mockResolvedValue([publicRoot, privateRoot])
    const memberships = spyOn(StreamMemberRepository, "findByStreamsAndMember").mockResolvedValue([])

    const result = await projectStreamsForUser(db, {
      workspaceId: "ws_1",
      streams: [privateRoot, privateThread, publicRoot, publicThread],
      userId: "usr_1",
    })

    expect(result.map(({ id, readOnlyReason }) => ({ id, readOnlyReason }))).toEqual([
      { id: publicRoot.id, readOnlyReason: "not_a_member" },
      { id: publicThread.id, readOnlyReason: "not_a_member" },
    ])
    expect(memberships).toHaveBeenCalledWith(db, [privateRoot.id, publicRoot.id], "usr_1")
  })

  test("batch bot descendant is writable when only its effective root is granted", async () => {
    const root = stream({ visibility: "private" })
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: root.id })
    spyOn(StreamRepository, "findByIdsInWorkspace").mockResolvedValue([root])
    const grants = spyOn(BotChannelAccessRepository, "filterGrantedStreamIds").mockResolvedValue(new Set([root.id]))
    const memberships = spyOn(StreamMemberRepository, "findByStreamsAndMember")

    const result = await projectStreamsForBot(db, {
      workspaceId: "ws_1",
      streams: [thread],
      botId: "bot_1",
    })

    expect(result[0]).toMatchObject({ id: thread.id, readOnly: false, readOnlyReason: null })
    expect(grants).toHaveBeenCalledWith(db, "ws_1", "bot_1", [root.id])
    expect(memberships).not.toHaveBeenCalled()
  })

  test("batch skips dangling roots before participation reads", async () => {
    const thread = stream({ id: "stream_thread", type: "thread", rootStreamId: "stream_missing" })
    spyOn(StreamRepository, "findByIdsInWorkspace").mockResolvedValue([])
    const memberships = spyOn(StreamMemberRepository, "findByStreamsAndMember")

    expect(await projectStreamsForUser(db, { workspaceId: "ws_1", streams: [thread], userId: "usr_1" })).toEqual([])
    expect(memberships).toHaveBeenCalledWith(db, [], "usr_1")
  })
})

test("structured denial uses the shared contract", () => {
  try {
    assertViewerStreamWritable({ readOnly: true, readOnlyReason: "archived" })
    throw new Error("expected denial")
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({
      status: 403,
      code: StreamErrorCodes.READ_ONLY,
      details: { reason: "archived" },
    })
  }
})
