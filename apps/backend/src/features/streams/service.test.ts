import { afterAll, describe, test, expect, mock, spyOn, beforeEach } from "bun:test"
import type { PoolClient } from "pg"
import { StreamService } from "./service"
import { StreamRepository } from "./repository"
import { StreamMemberRepository, type StreamMember } from "./member-repository"
import { ReadStateRepository } from "./read-state-repository"
import { StreamEventRepository } from "./event-repository"
import { SparseReadRepository } from "./sparse-read-repository"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { PersonaRepository } from "../agents"
import { MessageRepository } from "../messaging"
import { StreamContextRepository } from "../stream-context"
import { E2eStreamsRepository, E2eStreamActorsRepository, StreamE2eKeyWrapsRepository } from "../e2e-streams"
import { EnclaveRuntimesRepository } from "../enclave-runtimes"
import { BotRuntimeInstanceRepository } from "../bot-runtimes/repository"
import { BotRepository } from "../public-api/bot-repository"
import { BotChannelAccessRepository } from "../api-keys"
import * as idModule from "../../lib/id"
import * as db from "../../db"
import { HttpError } from "../../lib/errors"

const mockFindById = spyOn(StreamRepository, "findById")
spyOn(StreamRepository, "findByIds").mockImplementation(async (client, ids) => {
  const streams = await Promise.all(ids.map((id) => mockFindById(client, id)))
  return streams.filter((stream): stream is NonNullable<typeof stream> => stream != null)
})
spyOn(StreamRepository, "findByIdsInWorkspace").mockImplementation(async (client, _workspaceId, ids) => {
  const streams = await Promise.all(ids.map((id) => mockFindById(client, id)))
  return streams.filter((stream): stream is NonNullable<typeof stream> => stream != null)
})
const mockFindByIdsForUpdateBlocking = spyOn(StreamRepository, "findByIdsForUpdateBlocking").mockImplementation(
  async (client, _workspaceId, ids) => {
    const streams = await Promise.all(ids.map((id) => mockFindById(client, id)))
    return streams.filter((stream): stream is NonNullable<typeof stream> => stream != null)
  }
)
const mockLockMemberships = spyOn(StreamMemberRepository, "lockMemberships").mockImplementation(
  async (_client, streamIds) => new Set(streamIds)
)
spyOn(StreamMemberRepository, "lockMemberPairs").mockImplementation(
  async (_client, pairs) => new Set(pairs.map(({ streamId, memberId }) => `${streamId}:${memberId}`))
)
const mockLockGrants = spyOn(BotChannelAccessRepository, "lockGrants").mockResolvedValue(new Set())
const mockInsertOrFindByUniquenessKey = spyOn(StreamRepository, "insertOrFindByUniquenessKey")
const mockInsertMember = spyOn(StreamMemberRepository, "insert")
const mockInsertManyMembers = spyOn(StreamMemberRepository, "insertMany")
const mockIsMemberForUpdate = spyOn(StreamMemberRepository, "isMemberForUpdate")
const mockInsertEvent = spyOn(StreamEventRepository, "insert")
const mockInsertOutbox = spyOn(OutboxRepository, "insert")
const mockFindMembersByIds = spyOn(UserRepository, "findByIds")
const mockInsertStream = spyOn(StreamRepository, "insert")
const mockMarkStreamE2e = spyOn(E2eStreamsRepository, "markStreamE2e")
const mockUpdate = spyOn(StreamRepository, "update")
const mockUpdateDisplayName = spyOn(StreamRepository, "updateDisplayName")
const mockUpdateSealedName = spyOn(E2eStreamsRepository, "updateSealedName")
// Sparse read overlay pruning/listing runs inside the watermark write paths;
// stub against the fake `{}` client so unit tests never touch a real DB.
const mockPruneAtOrBelow = spyOn(SparseReadRepository, "pruneAtOrBelow").mockResolvedValue(undefined)
const mockDeleteAtOrAbove = spyOn(SparseReadRepository, "deleteAtOrAbove").mockResolvedValue(undefined)
const mockDeleteAllForStreams = spyOn(SparseReadRepository, "deleteAllForStreams").mockResolvedValue(undefined)
const mockListOverlayIds = spyOn(SparseReadRepository, "listOverlayIds").mockResolvedValue([])
// Read-state shadow writes run inside every watermark write path; stub against
// the fake `{}` client so unit tests never touch a real DB.
const mockReadStateAdvance = spyOn(ReadStateRepository, "advance").mockResolvedValue(null)
const mockReadStateSet = spyOn(ReadStateRepository, "set").mockResolvedValue(null)
const mockReadStateBatchAdvance = spyOn(ReadStateRepository, "batchAdvance").mockResolvedValue([])
const mockReadStateSetForUsers = spyOn(ReadStateRepository, "setForUsers").mockResolvedValue(undefined)
const mockSlugExists = spyOn(StreamRepository, "slugExistsInWorkspace")
const mockInsertManyEvents = spyOn(StreamEventRepository, "insertMany")
const mockInsertManyOutbox = spyOn(OutboxRepository, "insertMany")

spyOn(idModule, "eventId").mockReturnValue("evt_1")
spyOn(idModule, "streamId").mockReturnValue("stream_new")
spyOn(db, "withClient").mockImplementation((_pool, fn) => fn({} as PoolClient))
spyOn(db, "withTransaction").mockImplementation((_pool, fn) => fn({} as PoolClient))

// Module-level spies (declared via `const x = spyOn(...)`) stay attached to the
// target methods for the lifetime of this test file. Without this teardown the
// spies leak into the next test file in the worker — since Bun's `spyOn`
// returns the existing spy when a method is already patched, the next file
// inherits the call history and breaks `expect(...).not.toHaveBeenCalled()`.
afterAll(() => mock.restore())

describe("StreamService.isMemberOnForUpdate", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset()
    mockIsMemberForUpdate.mockReset()
  })

  test("locks and returns true for direct stream membership", async () => {
    const dbClient = {} as never
    mockIsMemberForUpdate.mockResolvedValue(true)

    await expect(service.isMemberOnForUpdate(dbClient, "stream_1", "usr_1")).resolves.toBe(true)

    expect(mockIsMemberForUpdate).toHaveBeenCalledWith(dbClient, "stream_1", "usr_1")
    expect(mockFindById).not.toHaveBeenCalled()
  })

  test("locks root membership when checking a thread", async () => {
    const dbClient = {} as never
    mockIsMemberForUpdate.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mockFindById.mockResolvedValue({ id: "stream_thread", rootStreamId: "stream_root" } as never)

    await expect(service.isMemberOnForUpdate(dbClient, "stream_thread", "usr_1")).resolves.toBe(true)

    expect(mockIsMemberForUpdate.mock.calls).toEqual([
      [dbClient, "stream_thread", "usr_1"],
      [dbClient, "stream_root", "usr_1"],
    ])
  })
})

describe("StreamService.setNotificationLevel", () => {
  let service: StreamService
  const mockUpdateMember = spyOn(StreamMemberRepository, "update")

  const membership: StreamMember = {
    streamId: "stream_1",
    memberId: "usr_1",
    notificationLevel: "muted",
    joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  }

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset()
    mockUpdateMember.mockReset()
    mockInsertOutbox.mockReset()
  })

  test("emits stream:notification_level_updated to the acting user on a real change", async () => {
    mockFindById.mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    mockUpdateMember.mockResolvedValue(membership as never)

    const result = await service.setNotificationLevel("ws_1", "stream_1", "usr_1", "muted")

    expect(result).toEqual(membership)
    expect(mockInsertOutbox).toHaveBeenCalledWith(expect.anything(), "stream:notification_level_updated", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      notificationLevel: "muted",
    })
  })

  test("unmute (null level) skips stream validation and broadcasts the cleared level", async () => {
    mockUpdateMember.mockResolvedValue({ ...membership, notificationLevel: null } as never)

    await service.setNotificationLevel("ws_1", "stream_1", "usr_1", null)

    expect(mockFindById).not.toHaveBeenCalled()
    expect(mockInsertOutbox).toHaveBeenCalledWith(expect.anything(), "stream:notification_level_updated", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      notificationLevel: null,
    })
  })

  test("does not emit when the user is not a member (no membership row updated)", async () => {
    mockUpdateMember.mockResolvedValue(null)

    const result = await service.setNotificationLevel("ws_1", "stream_1", "usr_1", null)

    expect(result).toBeNull()
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })
})

describe("StreamService.joinPublicChannel", () => {
  let service: StreamService

  beforeEach(() => {
    mockFindById.mockReset()
    mockInsertMember.mockReset().mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: null,
      joinedAt: new Date(),
    } as never)
    mockInsertEvent.mockReset().mockResolvedValue({
      id: "evt_1",
      streamId: "stream_1",
      sequence: 1n,
      eventType: "member_joined",
      payload: {},
      actorId: "member_1",
      actorType: "user",
      createdAt: new Date(),
    } as never)
    mockInsertOutbox.mockReset().mockResolvedValue({
      id: 1n,
      eventType: "stream:member_joined",
      payload: {},
      createdAt: new Date(),
    } as never)
    service = new StreamService({} as never)
  })

  test("should return membership when joining a public channel", async () => {
    mockFindById.mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "channel",
      visibility: "public",
    } as never)

    const result = await service.joinPublicChannel("stream_1", "ws_1", "member_1")

    expect(result).toMatchObject({ streamId: "stream_1", memberId: "member_1" })
    expect(mockInsertMember).toHaveBeenCalledWith({}, "stream_1", "member_1")
  })

  test("should emit member_joined stream event and outbox event", async () => {
    mockFindById.mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "channel",
      visibility: "public",
    } as never)

    await service.joinPublicChannel("stream_1", "ws_1", "member_1")

    expect(mockInsertEvent).toHaveBeenCalledWith(
      {},
      {
        id: "evt_1",
        streamId: "stream_1",
        eventType: "member_joined",
        payload: {},
        actorId: "member_1",
        actorType: "user",
      }
    )

    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:member_joined", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      event: expect.objectContaining({
        id: "evt_1",
        streamId: "stream_1",
        eventType: "member_joined",
        actorId: "member_1",
      }),
    })
  })

  test("should throw 404 when stream does not exist", async () => {
    mockFindById.mockResolvedValue(null)

    await expect(service.joinPublicChannel("stream_x", "ws_1", "member_1")).rejects.toThrow("Stream not found")
  })

  test("should throw 404 when stream belongs to different workspace", async () => {
    mockFindById.mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_other",
      type: "channel",
      visibility: "public",
    } as never)

    await expect(service.joinPublicChannel("stream_1", "ws_1", "member_1")).rejects.toThrow("Stream not found")
  })

  test("should throw 403 when stream is not a channel", async () => {
    mockFindById.mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "scratchpad",
      visibility: "public",
    } as never)

    const error = await service.joinPublicChannel("stream_1", "ws_1", "member_1").catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).message).toBe("Can only join public channels")
  })

  test("should throw 403 when channel is private", async () => {
    mockFindById.mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "channel",
      visibility: "private",
    } as never)

    const error = await service.joinPublicChannel("stream_1", "ws_1", "member_1").catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
  })
})

describe("StreamService.resolveWritableMessageStream", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
  })

  test("should resolve DM target via findOrCreateDm", async () => {
    const dmStream = {
      id: "stream_dm",
      workspaceId: "ws_1",
      type: "dm",
      archivedAt: null,
    } as never

    const findOrCreateDmSpy = spyOn(service, "findOrCreateDm").mockResolvedValue(dmStream)
    const isMemberSpy = spyOn(service, "isMember").mockResolvedValue(true)

    const resolved = await service.resolveWritableMessageStream({
      workspaceId: "ws_1",
      userId: "usr_1",
      target: { dmUserId: "usr_2" },
    })

    expect(findOrCreateDmSpy).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userOneId: "usr_1",
      userTwoId: "usr_2",
    })
    expect(isMemberSpy).not.toHaveBeenCalled()
    expect(resolved).toBe(dmStream)
  })

  test("should throw 403 when stream is archived", async () => {
    spyOn(service, "getStreamById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "scratchpad",
      visibility: "private",
      archivedAt: new Date(),
    } as never)
    spyOn(service, "isMember").mockResolvedValue(true)

    const error = await service
      .resolveWritableMessageStream({
        workspaceId: "ws_1",
        userId: "usr_1",
        target: { streamId: "stream_1" },
      })
      .catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).code).toBe("STREAM_READ_ONLY")
    expect((error as HttpError).details).toEqual({ reason: "archived" })
  })

  test("should throw 403 when member cannot write to stream", async () => {
    spyOn(service, "getStreamById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "scratchpad",
      visibility: "public",
      archivedAt: null,
    } as never)
    spyOn(service, "isMember").mockResolvedValue(false)

    const error = await service
      .resolveWritableMessageStream({
        workspaceId: "ws_1",
        userId: "usr_1",
        target: { streamId: "stream_1" },
      })
      .catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).code).toBe("STREAM_READ_ONLY")
    expect((error as HttpError).details).toEqual({ reason: "not_a_member" })
  })

  test("should throw 403 when a thread's root stream is archived", async () => {
    const getStreamByIdSpy = spyOn(service, "getStreamById")
    // First call resolves the target thread (active itself); second call
    // resolves its root, which is archived — the thread inherits the seal.
    getStreamByIdSpy
      .mockResolvedValueOnce({
        id: "stream_thread",
        workspaceId: "ws_1",
        type: "thread",
        rootStreamId: "stream_root",
        archivedAt: null,
      } as never)
      .mockResolvedValueOnce({
        id: "stream_root",
        workspaceId: "ws_1",
        type: "scratchpad",
        visibility: "private",
        archivedAt: new Date(),
      } as never)
    const isMemberSpy = spyOn(service, "isMember").mockResolvedValue(true)

    const error = await service
      .resolveWritableMessageStream({
        workspaceId: "ws_1",
        userId: "usr_1",
        target: { streamId: "stream_thread" },
      })
      .catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).code).toBe("STREAM_READ_ONLY")
    expect((error as HttpError).details).toEqual({ reason: "archived" })
    expect(isMemberSpy).toHaveBeenCalledWith("stream_root", "usr_1")
  })
})

describe("StreamService.findOrCreateDm", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindMembersByIds.mockReset()
    mockInsertOrFindByUniquenessKey.mockReset()
    mockInsertManyMembers.mockReset().mockResolvedValue([] as never)
    mockInsertOutbox.mockReset().mockResolvedValue({
      id: 1n,
      eventType: "stream:created",
      payload: {},
      createdAt: new Date(),
    } as never)
  })

  test("should create or find dm by canonical uniqueness key without pre-read", async () => {
    const stream = {
      id: "stream_dm_1",
      workspaceId: "ws_1",
      type: "dm",
      visibility: "private",
    } as never

    mockFindMembersByIds.mockResolvedValue([
      { id: "usr_1", workspaceId: "ws_1" },
      { id: "usr_2", workspaceId: "ws_1" },
    ] as never)
    mockInsertOrFindByUniquenessKey.mockResolvedValue({ stream, created: true } as never)

    const result = await service.findOrCreateDm({
      workspaceId: "ws_1",
      userOneId: "usr_2",
      userTwoId: "usr_1",
    })

    expect(mockInsertOrFindByUniquenessKey).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "ws_1",
        type: "dm",
        uniquenessKey: "dm:usr_1:usr_2",
        createdBy: "usr_2",
      })
    )
    expect(mockInsertManyMembers).toHaveBeenCalledWith({}, "stream_dm_1", ["usr_1", "usr_2"])
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:created",
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_dm_1",
        dmUserIds: ["usr_1", "usr_2"],
      })
    )
    expect(result).toBe(stream)
  })

  test("should not emit stream created event when dm already exists", async () => {
    const stream = {
      id: "stream_dm_1",
      workspaceId: "ws_1",
      type: "dm",
      visibility: "private",
    } as never

    mockFindMembersByIds.mockResolvedValue([
      { id: "usr_1", workspaceId: "ws_1" },
      { id: "usr_2", workspaceId: "ws_1" },
    ] as never)
    mockInsertOrFindByUniquenessKey.mockResolvedValue({ stream, created: false } as never)

    await service.findOrCreateDm({
      workspaceId: "ws_1",
      userOneId: "usr_1",
      userTwoId: "usr_2",
    })

    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })

  test("should throw when either member is outside the workspace", async () => {
    mockFindMembersByIds.mockResolvedValue([{ id: "usr_1", workspaceId: "ws_1" }] as never)

    const error = await service
      .findOrCreateDm({
        workspaceId: "ws_1",
        userOneId: "usr_1",
        userTwoId: "usr_2",
      })
      .catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(404)
    expect((error as HttpError).message).toBe("Both users must belong to this workspace")
  })
})

describe("StreamService.createThread (via create)", () => {
  let service: StreamService

  const parentStream = {
    id: "stream_channel",
    workspaceId: "ws_1",
    type: "channel",
    visibility: "private",
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
  }

  const thread = {
    id: "stream_new",
    workspaceId: "ws_1",
    type: "thread",
    visibility: "private",
    parentStreamId: "stream_channel",
    parentAnchorId: "msg_1",
    rootStreamId: "stream_channel",
    createdBy: "member_creator",
    createdAt: new Date().toISOString(),
  }

  const mockInsertThreadOrFind = spyOn(StreamRepository, "insertThreadOrFind")
  // createThreadOn locks the msg anchor FOR UPDATE (INV-20), so the anchor lookup
  // this describe drives is findByIdForUpdate.
  const mockMessageFindByIdForUpdate = spyOn(MessageRepository, "findByIdForUpdate")
  const mockIsMember = spyOn(StreamMemberRepository, "isMember")
  const mockFindByStreamAndMember = spyOn(StreamMemberRepository, "findByStreamAndMember")
  const mockUpdateMember = spyOn(StreamMemberRepository, "update")
  const mockInsertContext = spyOn(StreamContextRepository, "insertMany")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockInsertContext.mockReset().mockResolvedValue(0)
    mockFindById.mockReset().mockResolvedValue(parentStream as never)
    mockInsertThreadOrFind.mockReset().mockResolvedValue({ stream: thread, created: true } as never)
    mockIsMember.mockReset().mockResolvedValue(false)
    mockInsertMember.mockReset().mockResolvedValue({
      streamId: thread.id,
      memberId: "member_creator",
      notificationLevel: null,
      joinedAt: new Date(),
    } as never)
    mockFindByStreamAndMember.mockReset().mockResolvedValue(null)
    mockInsertEvent.mockReset().mockResolvedValue({
      id: "evt_1",
      streamId: thread.id,
      sequence: 1n,
      eventType: "member_added",
      payload: {},
      actorId: "member_author",
      actorType: "user",
      createdAt: new Date(),
    } as never)
    mockUpdateMember.mockReset().mockResolvedValue(undefined as never)
    mockInsertOutbox.mockReset().mockResolvedValue({ id: 1n } as never)
  })

  test("emits stream:member_added for parent message author so they see the thread in real-time", async () => {
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:member_added",
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: thread.id,
        memberId: "member_author",
      })
    )
  })

  test("indexes the thread on the parent stream at the anchor message's created_at", async () => {
    const anchorCreatedAt = new Date("2026-05-02T08:30:00.000Z")
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
      sequence: 9n,
      contentMarkdown: "**anchor** message",
      createdAt: anchorCreatedAt,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    const [row] = mockInsertContext.mock.calls[0]?.[1] as unknown as Array<Record<string, unknown>>
    const { id, ...rest } = row
    expect(rest).toEqual({
      workspaceId: "ws_1",
      streamId: "stream_channel",
      rootStreamId: "stream_channel",
      category: "thread",
      refKind: "thread",
      refId: "stream_new",
      groupKey: "stream_new",
      sourceMessageId: "msg_1",
      authorId: "member_author",
      occurredAt: anchorCreatedAt,
      sequence: 9n,
      snippet: "anchor message",
      detail: {},
    })
  })

  test("inherits memoryMode from the root stream", async () => {
    mockFindById.mockReset().mockResolvedValue({ ...parentStream, memoryMode: "off" } as never)
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    expect(mockInsertThreadOrFind).toHaveBeenCalledWith({}, expect.objectContaining({ memoryMode: "off" }))
  })

  test("does not emit stream:member_added when author is the thread creator", async () => {
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_creator",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    const memberAddedCalls = mockInsertOutbox.mock.calls.filter(([, type]) => type === "stream:member_added")
    expect(memberAddedCalls).toHaveLength(0)
  })

  test("does not emit stream:member_added for bot-authored parent messages", async () => {
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "bot",
      authorId: "bot_1",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    const memberAddedCalls = mockInsertOutbox.mock.calls.filter(([, type]) => type === "stream:member_added")
    expect(memberAddedCalls).toHaveLength(0)
  })

  test("emits stream:created to parent stream room when thread is newly created", async () => {
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:created",
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_channel",
      })
    )
  })

  test("seals a thread created under an E2E scratchpad root (INV-E1: inherit key, wraps, actors)", async () => {
    // Root scratchpad is E2E; the thread must inherit its E2E state in the same
    // transaction so replies can't land as server-readable plaintext.
    const e2eRoot = {
      id: "stream_root",
      workspaceId: "ws_1",
      type: "scratchpad",
      visibility: "private",
      rootStreamId: null,
      companionMode: "on",
      companionPersonaId: null,
      e2eEnabled: true,
    }
    const e2eThread = { ...thread, parentStreamId: "stream_root", rootStreamId: "stream_root" }
    const sealedThread = { ...e2eThread, e2eEnabled: true, e2eOwnerKeyId: "uik_owner" }

    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_root",
      authorType: "user",
      authorId: "member_author",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)
    // findById: parent/root → e2eRoot; the post-copy re-read of the thread → sealed.
    mockFindById
      .mockReset()
      .mockImplementation(((_c: unknown, id: string) =>
        Promise.resolve(id === e2eThread.id ? sealedThread : e2eRoot)) as never)
    mockInsertThreadOrFind.mockResolvedValue({ stream: { ...e2eThread }, created: true } as never)

    const getByStreamId = spyOn(E2eStreamsRepository, "getByStreamId").mockResolvedValue({
      streamId: "stream_root",
      workspaceId: "ws_1",
      ownerUserId: "usr_owner",
      ownerUserKeyId: "uik_owner",
      currentKeyGeneration: 2,
      enabledAt: new Date(),
    } as never)
    mockMarkStreamE2e.mockReset().mockResolvedValue({} as never)
    const copyActors = spyOn(E2eStreamActorsRepository, "copyToStream").mockResolvedValue(undefined as never)

    const result = await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_root",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    expect(getByStreamId).toHaveBeenCalledWith({}, "ws_1", "stream_root")
    expect(mockMarkStreamE2e).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        streamId: e2eThread.id,
        workspaceId: "ws_1",
        ownerUserId: "usr_owner",
        ownerUserKeyId: "uik_owner",
        currentKeyGeneration: 2,
      })
    )
    // Actors are copied (so the enclave-actor dispatch gate fires for the thread)
    // but key-WRAPS are NOT — the thread shares the root's SSK and resolves it
    // against the root's wraps (a copied wrap is HPKE-bound to the root id and
    // can't be unwrapped under the thread id).
    expect(copyActors).toHaveBeenCalledWith(
      {},
      { workspaceId: "ws_1", fromStreamId: "stream_root", toStreamId: e2eThread.id }
    )
    expect(StreamE2eKeyWrapsRepository).not.toHaveProperty("copyToStream")
    // The returned/broadcast thread reflects the sealed state.
    expect(result.e2eEnabled).toBe(true)
  })
})

describe("StreamService.createThreadOn anchor routing", () => {
  let service: StreamService

  const parentStream = {
    id: "stream_channel",
    workspaceId: "ws_1",
    type: "channel",
    visibility: "private",
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
  }

  const thread = {
    id: "stream_new",
    workspaceId: "ws_1",
    type: "thread",
    visibility: "private",
    parentStreamId: "stream_channel",
    parentAnchorId: "event_1",
    rootStreamId: "stream_channel",
    createdBy: "member_creator",
    createdAt: new Date().toISOString(),
  }

  const mockInsertThreadOrFind = spyOn(StreamRepository, "insertThreadOrFind")
  // createThreadOn locks the anchor message FOR UPDATE (INV-20) — the msg-anchor
  // race guard — so the routing test spies the locking read, not plain findById.
  const mockMessageFindByIdForUpdate = spyOn(MessageRepository, "findByIdForUpdate")
  const mockEventFindById = spyOn(StreamEventRepository, "findById")
  const mockIsMember = spyOn(StreamMemberRepository, "isMember")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset().mockResolvedValue(parentStream as never)
    mockInsertThreadOrFind.mockReset().mockResolvedValue({ stream: thread, created: true } as never)
    mockIsMember.mockReset().mockResolvedValue(false)
    mockInsertMember.mockReset().mockResolvedValue({} as never)
    mockInsertEvent.mockReset().mockResolvedValue({ id: "evt_1", actorId: "member_author" } as never)
    mockInsertOutbox.mockReset().mockResolvedValue({ id: 1n } as never)
    mockMessageFindByIdForUpdate.mockReset()
    mockEventFindById.mockReset()
  })

  test("event anchor: threadable event succeeds, passes parentAnchorId, adds event actor as member", async () => {
    mockEventFindById.mockResolvedValue({
      id: "event_1",
      streamId: "stream_channel",
      eventType: "delegation:created",
      actorId: "member_author",
      actorType: "user",
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "event_1",
      createdBy: "member_creator",
    })

    expect(mockMessageFindByIdForUpdate).not.toHaveBeenCalled()
    expect(mockInsertThreadOrFind).toHaveBeenCalledWith({}, expect.objectContaining({ parentAnchorId: "event_1" }))
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:member_added",
      expect.objectContaining({ streamId: thread.id, memberId: "member_author" })
    )
  })

  test("event anchor: indexes the thread at the anchor event's created_at, with no source message", async () => {
    const mockInsertContext = spyOn(StreamContextRepository, "insertMany")
    mockInsertContext.mockReset().mockResolvedValue(0)
    const anchorCreatedAt = new Date("2026-05-03T11:15:00.000Z")
    mockEventFindById.mockResolvedValue({
      id: "event_1",
      streamId: "stream_channel",
      eventType: "delegation:created",
      actorId: "member_author",
      actorType: "user",
      sequence: 12n,
      createdAt: anchorCreatedAt,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "event_1",
      createdBy: "member_creator",
    })

    const [row] = mockInsertContext.mock.calls[0]?.[1] as unknown as Array<Record<string, unknown>>
    const { id, ...rest } = row
    expect(rest).toEqual({
      workspaceId: "ws_1",
      streamId: "stream_channel",
      rootStreamId: "stream_channel",
      category: "thread",
      refKind: "thread",
      refId: thread.id,
      groupKey: thread.id,
      sourceMessageId: null,
      authorId: "member_author",
      occurredAt: anchorCreatedAt,
      sequence: 12n,
      snippet: "",
      detail: { anchorEventId: "event_1" },
    })
  })

  test("event anchor: non-user actor is not added as a member", async () => {
    mockEventFindById.mockResolvedValue({
      id: "event_1",
      streamId: "stream_channel",
      eventType: "call_started",
      actorId: "usr_host",
      actorType: "system",
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "event_1",
      createdBy: "member_creator",
    })

    const memberAddedCalls = mockInsertOutbox.mock.calls.filter(([, type]) => type === "stream:member_added")
    expect(memberAddedCalls).toHaveLength(0)
  })

  test("event anchor: a non-threadable event type is rejected", async () => {
    mockEventFindById.mockResolvedValue({
      id: "event_1",
      streamId: "stream_channel",
      eventType: "member_joined",
      actorId: "member_author",
      actorType: "user",
    } as never)

    await expect(
      service.create({
        workspaceId: "ws_1",
        type: "thread",
        parentStreamId: "stream_channel",
        parentAnchorId: "event_1",
        createdBy: "member_creator",
      })
    ).rejects.toMatchObject({ status: 400, code: "ANCHOR_NOT_THREADABLE" })
    expect(mockInsertThreadOrFind).not.toHaveBeenCalled()
  })

  test("event anchor: a message_created event id is rejected (messages anchor by msg_ id)", async () => {
    mockEventFindById.mockResolvedValue({
      id: "event_1",
      streamId: "stream_channel",
      eventType: "message_created",
      actorId: "member_author",
      actorType: "user",
    } as never)

    await expect(
      service.create({
        workspaceId: "ws_1",
        type: "thread",
        parentStreamId: "stream_channel",
        parentAnchorId: "event_1",
        createdBy: "member_creator",
      })
    ).rejects.toMatchObject({ status: 400, code: "ANCHOR_NOT_THREADABLE" })
    expect(mockInsertThreadOrFind).not.toHaveBeenCalled()
  })

  test("event anchor: a missing event is rejected", async () => {
    mockEventFindById.mockResolvedValue(null)

    await expect(
      service.create({
        workspaceId: "ws_1",
        type: "thread",
        parentStreamId: "stream_channel",
        parentAnchorId: "event_missing",
        createdBy: "member_creator",
      })
    ).rejects.toMatchObject({ status: 404, code: "ANCHOR_NOT_FOUND" })
  })

  test("event anchor: an event on another stream is rejected", async () => {
    mockEventFindById.mockResolvedValue({
      id: "event_1",
      streamId: "stream_other",
      eventType: "delegation:created",
      actorId: "member_author",
      actorType: "user",
    } as never)

    await expect(
      service.create({
        workspaceId: "ws_1",
        type: "thread",
        parentStreamId: "stream_channel",
        parentAnchorId: "event_1",
        createdBy: "member_creator",
      })
    ).rejects.toMatchObject({ status: 404, code: "ANCHOR_NOT_FOUND" })
  })

  test("an unrecognized anchor prefix is rejected", async () => {
    await expect(
      service.create({
        workspaceId: "ws_1",
        type: "thread",
        parentStreamId: "stream_channel",
        parentAnchorId: "conv_1",
        createdBy: "member_creator",
      })
    ).rejects.toMatchObject({ status: 400, code: "ANCHOR_INVALID" })
    expect(mockMessageFindByIdForUpdate).not.toHaveBeenCalled()
    expect(mockEventFindById).not.toHaveBeenCalled()
  })

  test("message anchor: routes through the message lookup and passes the msg id as the anchor", async () => {
    mockMessageFindByIdForUpdate.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
      contentMarkdown: "anchor",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      sequence: 1n,
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentAnchorId: "msg_1",
      createdBy: "member_creator",
    })

    expect(mockEventFindById).not.toHaveBeenCalled()
    expect(mockInsertThreadOrFind).toHaveBeenCalledWith({}, expect.objectContaining({ parentAnchorId: "msg_1" }))
  })
})

describe("StreamService.inviteActor", () => {
  let service: StreamService

  const mockGetByStreamId = spyOn(E2eStreamsRepository, "getByStreamId")
  const mockAddActor = spyOn(E2eStreamActorsRepository, "add")
  const mockFindByIdForWorkspace = spyOn(StreamRepository, "findByIdForWorkspace")
  const mockListForStream = spyOn(E2eStreamActorsRepository, "listForStream")
  const mockListLiveEiks = spyOn(EnclaveRuntimesRepository, "listLive")
  const mockFindBot = spyOn(BotRepository, "findById")
  const mockFindLiveBiks = spyOn(BotRuntimeInstanceRepository, "findLiveWithKeyForBot")

  const updatedStream = {
    id: "stream_e2e",
    workspaceId: "ws_1",
    type: "scratchpad",
    e2eEnabled: true,
    e2eActors: [{ kind: "enclave", actorId: "enclave", keyId: null }],
  } as never

  const ownedE2eStream = {
    streamId: "stream_e2e",
    workspaceId: "ws_1",
    ownerUserId: "usr_owner",
    ownerUserKeyId: "e2ek_owner",
    currentKeyGeneration: 0,
  } as never

  beforeEach(() => {
    service = new StreamService({} as never)
    mockGetByStreamId.mockReset()
    mockAddActor.mockReset().mockResolvedValue(true)
    mockFindByIdForWorkspace.mockReset().mockResolvedValue(updatedStream)
    mockInsertOutbox.mockReset().mockResolvedValue({ id: 1n } as never)
    // Default: one enclave actor, no live key → keyRoll null. Tests opt in.
    mockListForStream.mockReset().mockResolvedValue([{ kind: "enclave", actorId: "enclave", keyId: null }])
    mockListLiveEiks.mockReset().mockResolvedValue([])
    mockFindBot.mockReset().mockResolvedValue({ id: "bot_pi", archivedAt: null } as never)
    mockFindLiveBiks.mockReset().mockResolvedValue([])
  })

  test("pins the enclave sentinel id, emits stream:updated, and returns null keyRoll when no live key exists", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)

    const result = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "enclave")

    expect(mockAddActor).toHaveBeenCalledWith({}, "ws_1", "stream_e2e", "enclave", "enclave", null)
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:updated", {
      workspaceId: "ws_1",
      streamId: "stream_e2e",
      stream: updatedStream,
    })
    expect(result.stream).toBe(updatedStream)
    expect(result.keyRoll).toBeNull()
  })

  test("returns a keyRoll wrapping the next generation to every live enclave EIK", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)
    mockListLiveEiks.mockResolvedValue([
      { keyId: "eik_a", publicKey: new Uint8Array([1, 2, 3]) },
      { keyId: "eik_b", publicKey: new Uint8Array([4, 5, 6]) },
    ] as never)

    const result = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "enclave")

    expect(result.keyRoll).toEqual({
      nextGeneration: 1,
      recipients: [
        { recipientKeyId: "eik_a", recipientKind: "enclave", publicKey: Buffer.from([1, 2, 3]).toString("base64") },
        { recipientKeyId: "eik_b", recipientKind: "enclave", publicKey: Buffer.from([4, 5, 6]).toString("base64") },
      ],
    })
  })

  test("pins the bot by id and wraps to that bot's live BIKs (no active-actor guess)", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)
    mockListForStream.mockResolvedValue([{ kind: "bot", actorId: "bot_pi", keyId: null }])
    mockFindLiveBiks.mockResolvedValue([{ publicKey: "Ymlr", publicKeyId: "bik_1" }] as never)

    const result = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "bot", "bot_pi")

    expect(mockFindBot).toHaveBeenCalledWith({}, "ws_1", "bot_pi")
    expect(mockAddActor).toHaveBeenCalledWith({}, "ws_1", "stream_e2e", "bot", "bot_pi", null)
    expect(mockFindLiveBiks).toHaveBeenCalledWith({}, expect.objectContaining({ botId: "bot_pi" }))
    expect(result.keyRoll).toEqual({
      nextGeneration: 1,
      recipients: [{ recipientKeyId: "bik_1", recipientKind: "bot", publicKey: "Ymlr" }],
    })
  })

  test("wraps to every invited bot's BIKs when a scratchpad holds multiple bots", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)
    mockListForStream.mockResolvedValue([
      { kind: "bot", actorId: "bot_a", keyId: null },
      { kind: "bot", actorId: "bot_b", keyId: null },
    ])
    mockFindLiveBiks.mockImplementation((_db, params: { botId: string }) =>
      Promise.resolve(
        params.botId === "bot_a"
          ? ([{ publicKey: "QQ", publicKeyId: "bik_a" }] as never)
          : ([{ publicKey: "Qg", publicKeyId: "bik_b" }] as never)
      )
    )

    const result = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "bot", "bot_b")

    expect(result.keyRoll?.recipients.map((r) => r.recipientKeyId).sort()).toEqual(["bik_a", "bik_b"])
  })

  test("throws 404 when the named bot does not exist", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)
    mockFindBot.mockResolvedValue(null)

    const error = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "bot", "bot_ghost").catch((e) => e)

    expect((error as HttpError).status).toBe(404)
    expect((error as HttpError).code).toBe("BOT_NOT_FOUND")
    expect(mockAddActor).not.toHaveBeenCalled()
  })

  test("throws 400 when inviting a bot without a bot id", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)

    const error = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "bot").catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("ACTOR_ID_REQUIRED")
    expect(mockAddActor).not.toHaveBeenCalled()
  })

  test("throws 400 when the stream is not end-to-end encrypted", async () => {
    mockGetByStreamId.mockResolvedValue(null)

    const error = await service.inviteActor("ws_1", "stream_plain", "usr_owner", "enclave").catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("STREAM_NOT_E2E")
    expect(mockAddActor).not.toHaveBeenCalled()
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })

  test("throws 403 when the caller is not the stream owner", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)

    const error = await service.inviteActor("ws_1", "stream_e2e", "usr_intruder", "enclave").catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).code).toBe("NOT_STREAM_OWNER")
    expect(mockAddActor).not.toHaveBeenCalled()
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })

  test("throws 409 when that actor is already invited", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)
    mockAddActor.mockResolvedValue(false)

    const error = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "enclave").catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe("ACTOR_ALREADY_INVITED")
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })
})

describe("StreamService.rollStreamKey", () => {
  let service: StreamService

  const mockGetByStreamId = spyOn(E2eStreamsRepository, "getByStreamId")
  const mockInsertManyWraps = spyOn(StreamE2eKeyWrapsRepository, "insertMany")
  const mockBumpGeneration = spyOn(E2eStreamsRepository, "bumpKeyGeneration")

  // A transaction client that answers the advisory-lock query rollStreamKey
  // issues before any repo call.
  const lockClient = { query: mock(async () => ({ rows: [], rowCount: 0 })) } as never

  const ownedStream = {
    streamId: "stream_e2e",
    workspaceId: "ws_1",
    ownerUserId: "usr_owner",
    ownerUserKeyId: "e2ek_owner",
    currentKeyGeneration: 0,
  } as never

  const ownerWrap = { recipientKeyId: "e2ek_owner", recipientKind: "user", wrapEnc: "ZW5j", wrapCt: "Y3Q=" }
  const botWrap = { recipientKeyId: "bik_1", recipientKind: "bot", wrapEnc: "ZW5j", wrapCt: "Y3Q=" }

  beforeEach(() => {
    service = new StreamService({} as never)
    spyOn(db, "withTransaction").mockImplementation((_pool, fn) => fn(lockClient))
    mockGetByStreamId.mockReset().mockResolvedValue(ownedStream)
    mockInsertManyWraps.mockReset().mockResolvedValue(undefined as never)
    mockBumpGeneration.mockReset().mockResolvedValue({
      streamId: "stream_e2e",
      workspaceId: "ws_1",
      ownerUserId: "usr_owner",
      ownerUserKeyId: "e2ek_owner",
      currentKeyGeneration: 1,
    } as never)
  })

  // Restore the shared `withTransaction` stub (plain `{}` client) so the
  // lock-client impl set above doesn't leak into later describes.
  afterAll(() => {
    spyOn(db, "withTransaction").mockImplementation((_pool, fn) => fn({} as PoolClient))
  })

  test("stores the wrap batch and bumps the generation atomically", async () => {
    await service.rollStreamKey("ws_1", "stream_e2e", "usr_owner", {
      keyGeneration: 1,
      wraps: [ownerWrap, botWrap] as never,
    })

    expect(mockInsertManyWraps).toHaveBeenCalledWith(
      lockClient,
      expect.arrayContaining([expect.objectContaining({ keyGeneration: 1, recipientKeyId: "bik_1" })])
    )
    expect(mockBumpGeneration).toHaveBeenCalledWith(lockClient, {
      workspaceId: "ws_1",
      streamId: "stream_e2e",
      toGeneration: 1,
    })
  })

  test("throws 403 when the caller is not the owner", async () => {
    const error = await service
      .rollStreamKey("ws_1", "stream_e2e", "usr_intruder", { keyGeneration: 1, wraps: [ownerWrap] as never })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(403)
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
    expect(mockBumpGeneration).not.toHaveBeenCalled()
  })

  test("throws 409 when the generation is not exactly current + 1", async () => {
    const error = await service
      .rollStreamKey("ws_1", "stream_e2e", "usr_owner", { keyGeneration: 5, wraps: [ownerWrap] as never })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe("E2E_STALE_GENERATION")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 400 when the owner's own wrap is missing (no self-lockout)", async () => {
    const error = await service
      .rollStreamKey("ws_1", "stream_e2e", "usr_owner", { keyGeneration: 1, wraps: [botWrap] as never })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_OWNER_WRAP_MISSING")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 409 when the bump guard loses the race after wraps were staged", async () => {
    mockBumpGeneration.mockResolvedValue(null)

    const error = await service
      .rollStreamKey("ws_1", "stream_e2e", "usr_owner", { keyGeneration: 1, wraps: [ownerWrap] as never })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe("E2E_STALE_GENERATION")
  })
})

describe("StreamService.reviveActorKeyWraps", () => {
  let service: StreamService

  const mockGetByStreamId = spyOn(E2eStreamsRepository, "getByStreamId")
  const mockInsertManyWraps = spyOn(StreamE2eKeyWrapsRepository, "insertMany")
  const mockEnclaveGenerations = spyOn(StreamE2eKeyWrapsRepository, "listGenerationsForRecipientKind")
  const mockListActors = spyOn(E2eStreamActorsRepository, "listForStream")
  const mockListLiveEiks = spyOn(EnclaveRuntimesRepository, "listLive")
  const mockFindLiveBiks = spyOn(BotRuntimeInstanceRepository, "findLiveWithKeyForBot")

  // A transaction client that answers the advisory-lock query the revive
  // issues before any repo call (same serialization as rollStreamKey).
  const lockClient = { query: mock(async () => ({ rows: [], rowCount: 0 })) } as never

  const ownedStream = {
    streamId: "stream_e2e",
    workspaceId: "ws_1",
    ownerUserId: "usr_owner",
    ownerUserKeyId: "e2ek_owner",
    currentKeyGeneration: 1,
  } as never

  const enclaveWrap = { recipientKeyId: "eik_fresh", recipientKind: "enclave", wrapEnc: "ZW5j", wrapCt: "Y3Q=" }

  beforeEach(() => {
    service = new StreamService({} as never)
    spyOn(db, "withTransaction").mockImplementation((_pool, fn) => fn(lockClient))
    mockGetByStreamId.mockReset().mockResolvedValue(ownedStream)
    mockInsertManyWraps.mockReset().mockResolvedValue(undefined as never)
    mockEnclaveGenerations.mockReset().mockResolvedValue([])
    mockListActors.mockReset().mockResolvedValue([{ kind: "enclave", actorId: "enclave", keyId: null }])
    mockListLiveEiks.mockReset().mockResolvedValue([{ keyId: "eik_fresh", publicKey: new Uint8Array([1]) }] as never)
    mockFindLiveBiks.mockReset().mockResolvedValue([] as never)
  })

  afterAll(() => {
    spyOn(db, "withTransaction").mockImplementation((_pool, fn) => fn({} as PoolClient))
  })

  test("stores re-wraps for live actor keys at the current generation, with no generation bump", async () => {
    // `spyOn` returns the suite-shared spy (rollStreamKey's tests already called
    // it) — clear so the assertion below sees only this test's calls.
    const mockBumpGeneration = spyOn(E2eStreamsRepository, "bumpKeyGeneration")
    mockBumpGeneration.mockClear()

    await service.reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
      keyGeneration: 1,
      wraps: [enclaveWrap] as never,
    })

    expect(mockInsertManyWraps).toHaveBeenCalledWith(lockClient, [
      {
        workspaceId: "ws_1",
        streamId: "stream_e2e",
        keyGeneration: 1,
        recipientKeyId: "eik_fresh",
        recipientKind: "enclave",
        wrapEnc: "ZW5j",
        wrapCt: "Y3Q=",
      },
    ])
    expect(mockBumpGeneration).not.toHaveBeenCalled()
  })

  test("throws 403 when the caller is not the owner", async () => {
    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_intruder", { keyGeneration: 1, wraps: [enclaveWrap] as never })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).code).toBe("NOT_STREAM_OWNER")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 409 when the generation is not exactly current", async () => {
    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", { keyGeneration: 0, wraps: [enclaveWrap] as never })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(409)
    expect((error as HttpError).code).toBe("E2E_STALE_GENERATION")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 400 when a wrap targets a key that is not live for an invited actor", async () => {
    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
        keyGeneration: 1,
        wraps: [{ ...enclaveWrap, recipientKeyId: "eik_dead" }] as never,
      })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_RECIPIENT_NOT_LIVE_ACTOR")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 400 when a wrap targets a user key (revive can't add readers)", async () => {
    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
        keyGeneration: 1,
        // Even a key id that happens to be in the live set must be rejected by kind.
        wraps: [{ ...enclaveWrap, recipientKind: "user" }] as never,
      })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_RECIPIENT_NOT_LIVE_ACTOR")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  // E2EE-7: an enclave restart that follows a key roll leaves the parked turn
  // (and old history/digests) sealed under generations the fresh EIK has no
  // wrap for — revive must be able to re-address those generations too.
  test("stores an older-generation wrap for the enclave when a prior enclave wrap proves it held that generation", async () => {
    // The (dead) enclave EIK held generation 0; the owner's own gen-1 wrap is
    // not an enclave row, so the scoped read returns only [0].
    mockEnclaveGenerations.mockResolvedValue([0])

    await service.reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
      keyGeneration: 1,
      wraps: [enclaveWrap, { ...enclaveWrap, keyGeneration: 0 }] as never,
    })

    expect(mockInsertManyWraps).toHaveBeenCalledWith(lockClient, [
      expect.objectContaining({ keyGeneration: 1, recipientKeyId: "eik_fresh" }),
      expect.objectContaining({ keyGeneration: 0, recipientKeyId: "eik_fresh" }),
    ])
  })

  test("throws 400 for an older generation no enclave wrap ever existed at", async () => {
    // No enclave wrap exists at generation 0 (only the owner's user wrap), so
    // the scoped read returns no held generations — the enclave never held it.
    mockEnclaveGenerations.mockResolvedValue([])

    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
        keyGeneration: 1,
        wraps: [{ ...enclaveWrap, keyGeneration: 0 }] as never,
      })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_GENERATION_NOT_HELD")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 400 for an older-generation wrap addressed to a bot key (no per-bot history attribution)", async () => {
    mockListActors.mockResolvedValue([{ kind: "bot", actorId: "bot_1", keyId: null }] as never)
    mockFindLiveBiks.mockResolvedValue([{ publicKeyId: "bik_live", publicKey: "AA==" }] as never)
    mockListLiveEiks.mockResolvedValue([] as never)
    // Older generations are enclave-only: the scoped read returns enclave rows,
    // so a bot recipient can never satisfy the older-generation rule.
    mockEnclaveGenerations.mockResolvedValue([])

    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
        keyGeneration: 1,
        wraps: [
          { keyGeneration: 0, recipientKeyId: "bik_live", recipientKind: "bot", wrapEnc: "ZW5j", wrapCt: "Y3Q=" },
        ] as never,
      })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_GENERATION_NOT_HELD")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 400 when a wrap's kind doesn't match the live key's server-resolved kind", async () => {
    mockListActors.mockResolvedValue([{ kind: "bot", actorId: "bot_1", keyId: null }] as never)
    mockFindLiveBiks.mockResolvedValue([{ publicKeyId: "bik_live", publicKey: "AA==" }] as never)
    mockListLiveEiks.mockResolvedValue([] as never)
    // The enclave genuinely held generation 0 — but that must not help a live
    // bot key that merely relabels itself "enclave".
    mockEnclaveGenerations.mockResolvedValue([0])

    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
        keyGeneration: 1,
        wraps: [
          { keyGeneration: 0, recipientKeyId: "bik_live", recipientKind: "enclave", wrapEnc: "ZW5j", wrapCt: "Y3Q=" },
        ] as never,
      })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_RECIPIENT_NOT_LIVE_ACTOR")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })

  test("throws 400 when a wrap names a generation above current", async () => {
    const error = await service
      .reviveActorKeyWraps("ws_1", "stream_e2e", "usr_owner", {
        keyGeneration: 1,
        wraps: [{ ...enclaveWrap, keyGeneration: 2 }] as never,
      })
      .catch((e) => e)

    expect((error as HttpError).status).toBe(400)
    expect((error as HttpError).code).toBe("E2E_GENERATION_NOT_HELD")
    expect(mockInsertManyWraps).not.toHaveBeenCalled()
  })
})

describe("StreamService.createScratchpad (E2E)", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockInsertStream.mockReset().mockResolvedValue({
      id: "stream_new",
      workspaceId: "ws_1",
      type: "scratchpad",
    } as never)
    mockInsertMember.mockReset().mockResolvedValue(undefined as never)
    mockMarkStreamE2e.mockReset().mockResolvedValue({} as never)
    mockInsertOutbox.mockReset().mockResolvedValue({ id: 1n } as never)
  })

  test("initializes e2eActors to [] so the stream:created payload matches the read contract", async () => {
    await service.create({
      workspaceId: "ws_1",
      type: "scratchpad",
      createdBy: "usr_owner",
      e2e: { ownerKeyId: "e2ek_01" },
    } as never)

    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:created",
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_new",
        stream: expect.objectContaining({
          e2eEnabled: true,
          e2eOwnerKeyId: "e2ek_01",
          e2eActors: [],
        }),
      })
    )
  })

  test("defaults memoryMode off for a companion scratchpad (extract-from-bots is opt-in)", async () => {
    await service.create({
      workspaceId: "ws_1",
      type: "scratchpad",
      createdBy: "usr_owner",
      companionPersonaId: "persona_x",
    } as never)

    expect(mockInsertStream).toHaveBeenCalledWith({}, expect.objectContaining({ memoryMode: "off" }))
  })

  test("keeps memoryMode auto for a plain scratchpad", async () => {
    await service.create({
      workspaceId: "ws_1",
      type: "scratchpad",
      createdBy: "usr_owner",
    } as never)

    expect(mockInsertStream).toHaveBeenCalledWith({}, expect.objectContaining({ memoryMode: "auto" }))
  })

  test("respects an explicit memoryMode on a companion scratchpad", async () => {
    await service.create({
      workspaceId: "ws_1",
      type: "scratchpad",
      createdBy: "usr_owner",
      companionPersonaId: "persona_x",
      memoryMode: "auto",
    } as never)

    expect(mockInsertStream).toHaveBeenCalledWith({}, expect.objectContaining({ memoryMode: "auto" }))
  })
})

// The stream:read / stream:read_all payloads carry absolute read positions
// (sync phase 2c): clients derive unread as latestOrdinal - lastReadOrdinal,
// so these events must say where the read lands in message-ordinal space.
describe("StreamService.markAsRead", () => {
  let service: StreamService
  const mockGetMessageOrdinalForEvent = spyOn(StreamEventRepository, "getMessageOrdinalForEvent")
  const mockFindByStreamAndMember = spyOn(StreamMemberRepository, "findByStreamAndMember")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockGetMessageOrdinalForEvent.mockReset()
    mockFindByStreamAndMember.mockReset()
    mockReadStateAdvance.mockClear()
    mockInsertOutbox.mockReset()
    mockInsertOutbox.mockResolvedValue({} as never)
  })

  test("emits stream:read with the absolute read position", async () => {
    mockFindByStreamAndMember.mockResolvedValue({ streamId: "stream_1", memberId: "usr_1" } as never)
    mockGetMessageOrdinalForEvent.mockResolvedValue({ sequence: 42n, messageOrdinal: 7 })

    await service.markAsRead("ws_1", "stream_1", "usr_1", "evt_9")

    expect(mockGetMessageOrdinalForEvent).toHaveBeenCalledWith({}, "stream_1", "evt_9")
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      lastReadEventId: "evt_9",
      lastReadSequence: "42",
      lastReadOrdinal: 7,
      readMessageIds: [],
    })
    // The advance is the sole watermark write — monotonic (reads never regress it).
    expect(mockReadStateAdvance).toHaveBeenCalledWith({}, "stream_1", "usr_1", "evt_9")
  })

  test("sources the stream:read payload from the post-write frontier when it sits above the sent event", async () => {
    // Stale device: this mark-as-read carries evt_9 (seq 42), but the monotonic
    // store already stands at evt_higher (seq 90) from another session. The
    // advance is rejected, so the payload other sessions receive must carry the
    // post-write frontier, and the overlay prune must absorb at it — not at the
    // stale event.
    mockFindByStreamAndMember.mockResolvedValue({ streamId: "stream_1", memberId: "usr_1" } as never)
    mockGetMessageOrdinalForEvent.mockImplementation(async (_db, _streamId, eventId) => {
      if (eventId === "evt_9") return { sequence: 42n, messageOrdinal: 7 } as never
      if (eventId === "evt_higher") return { sequence: 90n, messageOrdinal: 12 } as never
      return null as never
    })
    mockReadStateAdvance.mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_higher",
    } as never)

    await service.markAsRead("ws_1", "stream_1", "usr_1", "evt_9")

    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      lastReadEventId: "evt_higher",
      lastReadSequence: "90",
      lastReadOrdinal: 12,
      readMessageIds: [],
    })
    expect(mockPruneAtOrBelow).toHaveBeenCalledWith({}, "stream_1", "usr_1", 90n)
  })

  test("keeps the sent event as the payload when the advance lands there", async () => {
    mockFindByStreamAndMember.mockResolvedValue({ streamId: "stream_1", memberId: "usr_1" } as never)
    mockGetMessageOrdinalForEvent.mockResolvedValue({ sequence: 42n, messageOrdinal: 7 } as never)
    mockReadStateAdvance.mockResolvedValue({
      streamId: "stream_1",
      userId: "usr_1",
      lastReadEventId: "evt_9",
    } as never)

    await service.markAsRead("ws_1", "stream_1", "usr_1", "evt_9")

    // No second ordinal resolution when the post-write row matches the sent event.
    expect(mockGetMessageOrdinalForEvent).toHaveBeenCalledTimes(1)
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      lastReadEventId: "evt_9",
      lastReadSequence: "42",
      lastReadOrdinal: 7,
      readMessageIds: [],
    })
    expect(mockPruneAtOrBelow).toHaveBeenCalledWith({}, "stream_1", "usr_1", 42n)
  })

  test("ignores a read pointer that doesn't resolve to a real event — no watermark write, no stream:read", async () => {
    // An optimistic temp_ id (or any id with no stream_events row) would pin the
    // unread query's COALESCE(sequence, 0) to 0 and report the whole stream — incl.
    // the user's own messages — as unread. Resolve first; no-op on a miss.
    mockGetMessageOrdinalForEvent.mockResolvedValue(null)
    mockFindByStreamAndMember.mockResolvedValue({ streamId: "stream_1", memberId: "usr_1" } as never)

    const result = await service.markAsRead("ws_1", "stream_1", "usr_1", "temp_optimistic")

    expect(mockInsertOutbox).not.toHaveBeenCalled()
    expect(mockReadStateAdvance).not.toHaveBeenCalled()
    expect(result).toEqual({
      membership: { streamId: "stream_1", memberId: "usr_1" } as never,
      readState: null,
      lastReadOrdinal: null,
      readMessageIds: null,
    })
  })

  test("advances the frontier and emits stream:read for a non-member — membership fetched read-only, never written", async () => {
    // Access (validated in the handler) gates the read, not membership (INV-62):
    // a non-member thread viewer gets the same watermark semantics. Membership is
    // fetched for participation only and returns null here — never upserted.
    mockGetMessageOrdinalForEvent.mockResolvedValue({ sequence: 42n, messageOrdinal: 7 })
    mockFindByStreamAndMember.mockResolvedValue(null)

    const result = await service.markAsRead("ws_1", "stream_1", "usr_1", "evt_9")

    expect(result).toEqual({
      membership: null,
      readState: { lastReadEventId: "evt_9", lastReadSequence: "42", lastReadAt: null },
      lastReadOrdinal: 7,
      readMessageIds: [],
    })
    expect(mockFindByStreamAndMember).toHaveBeenCalledWith({}, "stream_1", "usr_1")
    expect(mockReadStateAdvance).toHaveBeenCalledWith({}, "stream_1", "usr_1", "evt_9")
    expect(mockPruneAtOrBelow).toHaveBeenCalledWith({}, "stream_1", "usr_1", 42n)
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      lastReadEventId: "evt_9",
      lastReadSequence: "42",
      lastReadOrdinal: 7,
      readMessageIds: [],
    })
  })
})

describe("StreamService.markUnread", () => {
  let service: StreamService
  const mockFindByStreamAndMember = spyOn(StreamMemberRepository, "findByStreamAndMember")
  const mockFindByMessageId = spyOn(StreamEventRepository, "findByMessageId")
  const mockFindPreviousMessageEvent = spyOn(StreamEventRepository, "findPreviousMessageEvent")
  const mockCountMessagesThrough = spyOn(StreamEventRepository, "countMessagesThrough")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindByStreamAndMember.mockReset()
    mockFindByMessageId.mockReset()
    mockFindPreviousMessageEvent.mockReset()
    mockCountMessagesThrough.mockReset()
    mockReadStateSet.mockClear()
    mockInsertOutbox.mockReset()
    mockInsertOutbox.mockResolvedValue({} as never)
  })

  test("points the read pointer at the message before the target and emits stream:read_set", async () => {
    mockFindByMessageId.mockResolvedValue({ id: "evt_5", sequence: 50n } as never)
    mockFindPreviousMessageEvent.mockResolvedValue({ id: "evt_4", sequence: 40n } as never)
    mockCountMessagesThrough.mockResolvedValue(4)
    mockFindByStreamAndMember.mockResolvedValue({ streamId: "stream_1", memberId: "usr_1" } as never)

    await service.markUnread("ws_1", "stream_1", "usr_1", "msg_5")

    expect(mockCountMessagesThrough).toHaveBeenCalledWith({}, "stream_1", 40n)
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read_set", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      lastReadEventId: "evt_4",
      lastReadSequence: "40",
      lastReadOrdinal: 4,
      readMessageIds: [],
    })
    expect(mockDeleteAtOrAbove).toHaveBeenCalledWith({}, "stream_1", "usr_1", 50n)
    // The regress is the sole watermark write.
    expect(mockReadStateSet).toHaveBeenCalledWith({}, "stream_1", "usr_1", "evt_4")
  })

  test("clears the read pointer when the target is the first message", async () => {
    mockFindByMessageId.mockResolvedValue({ id: "evt_1", sequence: 10n } as never)
    mockFindPreviousMessageEvent.mockResolvedValue(null)
    mockFindByStreamAndMember.mockResolvedValue({ streamId: "stream_1", memberId: "usr_1" } as never)

    await service.markUnread("ws_1", "stream_1", "usr_1", "msg_1")

    expect(mockCountMessagesThrough).not.toHaveBeenCalled()
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:read_set",
      expect.objectContaining({ lastReadEventId: null, lastReadSequence: "0", lastReadOrdinal: 0 })
    )
    // Regress to null parks the frontier before the first message.
    expect(mockReadStateSet).toHaveBeenCalledWith({}, "stream_1", "usr_1", null)
  })

  test("throws MESSAGE_NOT_FOUND when the message is not in the stream", async () => {
    mockFindByMessageId.mockResolvedValue(null)

    await expect(service.markUnread("ws_1", "stream_1", "usr_1", "msg_gone")).rejects.toMatchObject({
      status: 404,
      code: "MESSAGE_NOT_FOUND",
    })
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })

  test("sets the frontier and emits stream:read_set for a non-member — membership fetched read-only, never written", async () => {
    // The same-class 404 is gone: a null membership is a successful unread by an
    // access-only viewer, not a missing message. Membership is fetched for
    // participation only and returns null here — never upserted (INV-62).
    mockFindByMessageId.mockResolvedValue({ id: "evt_5", sequence: 50n } as never)
    mockFindPreviousMessageEvent.mockResolvedValue({ id: "evt_4", sequence: 40n } as never)
    mockCountMessagesThrough.mockResolvedValue(4)
    mockFindByStreamAndMember.mockResolvedValue(null)

    const result = await service.markUnread("ws_1", "stream_1", "usr_1", "msg_5")

    expect(result).toEqual({
      membership: null,
      readState: { lastReadEventId: "evt_4", lastReadSequence: "40", lastReadAt: null },
    })
    expect(mockFindByStreamAndMember).toHaveBeenCalledWith({}, "stream_1", "usr_1")
    expect(mockReadStateSet).toHaveBeenCalledWith({}, "stream_1", "usr_1", "evt_4")
    expect(mockDeleteAtOrAbove).toHaveBeenCalledWith({}, "stream_1", "usr_1", 50n)
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read_set", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamId: "stream_1",
      lastReadEventId: "evt_4",
      lastReadSequence: "40",
      lastReadOrdinal: 4,
      readMessageIds: [],
    })
  })
})

describe("StreamService.markAllAsRead", () => {
  let service: StreamService
  const mockMemberList = spyOn(StreamMemberRepository, "list")
  const mockStreamList = spyOn(StreamRepository, "list")
  const mockLatestEventIds = spyOn(StreamEventRepository, "getLatestEventIdByStreamBatch")
  const mockReadStateGetBatch = spyOn(ReadStateRepository, "getBatch")
  const mockCountMessages = spyOn(StreamEventRepository, "countMessagesByStreamBatch")
  const mockGetSequences = spyOn(StreamEventRepository, "getSequencesByEventIds")
  const READ_ALL_AT = new Date("2024-01-01T00:00:00Z")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockMemberList.mockReset()
    mockStreamList.mockReset()
    mockLatestEventIds.mockReset()
    mockReadStateGetBatch.mockReset()
    mockCountMessages.mockReset()
    mockGetSequences.mockReset()
    mockGetSequences.mockResolvedValue(new Map())
    mockReadStateBatchAdvance.mockReset()
    mockReadStateBatchAdvance.mockResolvedValue([])
    mockInsertOutbox.mockReset()
    mockInsertOutbox.mockResolvedValue({} as never)
  })

  test("emits stream:read_all with per-stream absolute read positions and a frontier snapshot", async () => {
    mockMemberList.mockResolvedValue([
      { streamId: "stream_1", memberId: "usr_1" },
      { streamId: "stream_2", memberId: "usr_1" },
    ] as never)
    mockStreamList.mockResolvedValue([{ id: "stream_1" }, { id: "stream_2" }] as never)
    mockLatestEventIds.mockResolvedValue(
      new Map([
        ["stream_1", "evt_a"],
        ["stream_2", "evt_b"],
      ])
    )
    // Both frontiers sit below their latest event, so both advance.
    mockReadStateGetBatch.mockResolvedValue([
      { streamId: "stream_1", lastReadEventId: null },
      { streamId: "stream_2", lastReadEventId: "evt_old" },
    ] as never)
    // The batch advance returns the post-write standalone rows — the snapshot
    // source (sourced post-write, never from membership).
    mockReadStateBatchAdvance.mockResolvedValue([
      { streamId: "stream_1", lastReadEventId: "evt_a", lastReadAt: READ_ALL_AT },
      { streamId: "stream_2", lastReadEventId: "evt_b", lastReadAt: READ_ALL_AT },
    ] as never)
    mockGetSequences.mockResolvedValue(
      new Map([
        ["evt_a", "100"],
        ["evt_b", "50"],
      ])
    )
    // Read-all pins each frontier to the stream's latest event, so the absolute
    // position per stream is its total message count.
    mockCountMessages.mockResolvedValue(
      new Map([
        ["stream_1", 12],
        ["stream_2", 3],
      ])
    )

    const result = await service.markAllAsRead("ws_1", "usr_1")

    expect(result.updatedStreamIds).toEqual(["stream_1", "stream_2"])
    expect(result.frontiers).toEqual([
      {
        streamId: "stream_1",
        lastReadEventId: "evt_a",
        lastReadSequence: "100",
        lastReadOrdinal: 12,
        lastReadAt: READ_ALL_AT.toISOString(),
      },
      {
        streamId: "stream_2",
        lastReadEventId: "evt_b",
        lastReadSequence: "50",
        lastReadOrdinal: 3,
        lastReadAt: READ_ALL_AT.toISOString(),
      },
    ])
    expect(mockDeleteAllForStreams).toHaveBeenCalledWith({}, "usr_1", ["stream_1", "stream_2"])
    expect(mockCountMessages).toHaveBeenCalledWith({}, ["stream_1", "stream_2"])
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read_all", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamIds: ["stream_1", "stream_2"],
      reads: [
        { streamId: "stream_1", lastReadOrdinal: 12 },
        { streamId: "stream_2", lastReadOrdinal: 3 },
      ],
      frontiers: result.frontiers,
    })
    expect(mockReadStateBatchAdvance).toHaveBeenCalledWith(
      {},
      "usr_1",
      new Map([
        ["stream_1", "evt_a"],
        ["stream_2", "evt_b"],
      ])
    )
  })

  test("skips streams whose frontier already sits at the latest event", async () => {
    mockMemberList.mockResolvedValue([
      { streamId: "stream_1", memberId: "usr_1" },
      { streamId: "stream_2", memberId: "usr_1" },
    ] as never)
    mockStreamList.mockResolvedValue([{ id: "stream_1" }, { id: "stream_2" }] as never)
    mockLatestEventIds.mockResolvedValue(
      new Map([
        ["stream_1", "evt_a"],
        ["stream_2", "evt_b"],
      ])
    )
    // stream_1 is already fully read; only stream_2 advances.
    mockReadStateGetBatch.mockResolvedValue([
      { streamId: "stream_1", lastReadEventId: "evt_a" },
      { streamId: "stream_2", lastReadEventId: "evt_old" },
    ] as never)
    mockReadStateBatchAdvance.mockResolvedValue([
      { streamId: "stream_2", lastReadEventId: "evt_b", lastReadAt: READ_ALL_AT },
    ] as never)
    mockGetSequences.mockResolvedValue(new Map([["evt_b", "50"]]))
    mockCountMessages.mockResolvedValue(new Map([["stream_2", 3]]))

    const result = await service.markAllAsRead("ws_1", "usr_1")

    expect(result.updatedStreamIds).toEqual(["stream_2"])
    expect(result.frontiers).toEqual([
      {
        streamId: "stream_2",
        lastReadEventId: "evt_b",
        lastReadSequence: "50",
        lastReadOrdinal: 3,
        lastReadAt: READ_ALL_AT.toISOString(),
      },
    ])
    expect(mockReadStateBatchAdvance).toHaveBeenCalledWith({}, "usr_1", new Map([["stream_2", "evt_b"]]))
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:read_all",
      expect.objectContaining({ streamIds: ["stream_2"], frontiers: result.frontiers })
    )
  })

  test("carries the higher standing frontier when the monotonic guard rejects a concurrent advance", async () => {
    // stream_1's attempted advance loses a race: a concurrent read already
    // moved the watermark past evt_a, so the batch upsert's guard rejects it.
    // batchAdvance still returns the authoritative post-write row (evt_higher),
    // and updatedStreamIds/reads/frontiers/outbox all carry IT — every
    // attempted stream gets exactly one frontier.
    mockMemberList.mockResolvedValue([{ streamId: "stream_1", memberId: "usr_1" }] as never)
    mockStreamList.mockResolvedValue([{ id: "stream_1" }] as never)
    mockLatestEventIds.mockResolvedValue(new Map([["stream_1", "evt_a"]]))
    mockReadStateGetBatch.mockResolvedValue([{ streamId: "stream_1", lastReadEventId: null }] as never)
    mockReadStateBatchAdvance.mockResolvedValue([
      { streamId: "stream_1", lastReadEventId: "evt_higher", lastReadAt: READ_ALL_AT },
    ] as never)
    mockGetSequences.mockResolvedValue(new Map([["evt_higher", "900"]]))
    mockCountMessages.mockResolvedValue(new Map([["stream_1", 12]]))

    const result = await service.markAllAsRead("ws_1", "usr_1")

    expect(result.updatedStreamIds).toEqual(["stream_1"])
    expect(result.frontiers).toEqual([
      {
        streamId: "stream_1",
        lastReadEventId: "evt_higher",
        lastReadSequence: "900",
        lastReadOrdinal: 12,
        lastReadAt: READ_ALL_AT.toISOString(),
      },
    ])
    expect(mockInsertOutbox).toHaveBeenCalledWith({}, "stream:read_all", {
      workspaceId: "ws_1",
      authorId: "usr_1",
      streamIds: ["stream_1"],
      reads: [{ streamId: "stream_1", lastReadOrdinal: 12 }],
      frontiers: result.frontiers,
    })
  })

  test("emits nothing and returns empty frontiers when no stream advances", async () => {
    mockMemberList.mockResolvedValue([{ streamId: "stream_1", memberId: "usr_1" }] as never)
    mockStreamList.mockResolvedValue([{ id: "stream_1" }] as never)
    mockLatestEventIds.mockResolvedValue(new Map([["stream_1", "evt_a"]]))
    // Already at the latest event — nothing to advance.
    mockReadStateGetBatch.mockResolvedValue([{ streamId: "stream_1", lastReadEventId: "evt_a" }] as never)

    const result = await service.markAllAsRead("ws_1", "usr_1")

    expect(result).toEqual({ updatedStreamIds: [], frontiers: [] })
    expect(mockReadStateBatchAdvance).not.toHaveBeenCalled()
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })
})

describe("StreamService.updateStream sealed-name handling", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset()
    mockUpdate.mockReset()
    mockUpdateDisplayName.mockReset()
    mockUpdateSealedName.mockReset()
    mockInsertOutbox.mockReset()
  })

  test("setting a sealed name scrubs the plaintext display_name to null (INV-E1)", async () => {
    const stream = { id: "stream_1", workspaceId: "ws_1", displayName: null } as never
    mockUpdate.mockResolvedValue(stream)
    mockUpdateDisplayName.mockResolvedValue(stream)
    mockUpdateSealedName.mockResolvedValue(true)
    mockFindById.mockResolvedValue(stream)

    // Even if a client sends a plaintext displayName alongside the seal, the
    // server must not persist it — the sealed ciphertext is the only name.
    await service.updateStream(
      "stream_1",
      {
        displayName: "leak",
        sealedName: { ciphertext: "Y3Q=", envelope: { v: 1 } },
      },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    expect(mockUpdateDisplayName).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ streamId: "stream_1", displayName: null, source: "explicit" })
    )
    expect(mockUpdateSealedName).toHaveBeenCalledWith({}, "ws_1", "stream_1", {
      ciphertext: "Y3Q=",
      envelope: { v: 1 },
    })
  })

  test("setting a sealed name on a non-E2E stream fails loudly and emits no outbox event", async () => {
    const stream = { id: "stream_1", workspaceId: "ws_1", displayName: null } as never
    mockUpdate.mockResolvedValue(stream)
    mockUpdateDisplayName.mockResolvedValue(stream)
    mockFindById.mockResolvedValue(stream)
    // No e2e_streams row to update — the stream isn't E2E.
    mockUpdateSealedName.mockResolvedValue(false)

    await expect(
      service.updateStream(
        "stream_1",
        {
          sealedName: { ciphertext: "Y3Q=", envelope: { v: 1 } },
        },
        { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
      )
    ).rejects.toMatchObject({ status: 400, code: "STREAM_NOT_E2E" })

    // Transaction rolls back; no stream:updated event for a half-applied rename.
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })

  test("clearing a sealed name without a displayName is rejected", async () => {
    await expect(
      service.updateStream(
        "stream_1",
        { sealedName: null },
        { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "SEALED_NAME_REQUIRES_DISPLAY_NAME",
    })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  test("a plain (non-sealed) rename writes the plaintext displayName unchanged", async () => {
    const stream = { id: "stream_1", workspaceId: "ws_1", displayName: "New name" } as never
    mockUpdate.mockResolvedValue(stream)
    mockUpdateDisplayName.mockResolvedValue(stream)
    mockFindById.mockResolvedValue(stream)

    await service.updateStream(
      "stream_1",
      { displayName: "New name" },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    expect(mockUpdateDisplayName).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ streamId: "stream_1", displayName: "New name", source: "explicit" })
    )
    expect(mockUpdateSealedName).not.toHaveBeenCalled()
  })
})

describe("StreamService.updateStream description", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset()
    mockUpdate.mockReset()
    mockUpdateDisplayName.mockReset()
    mockInsertOutbox.mockReset()
    mockInsertEvent.mockReset().mockResolvedValue({ id: "evt_1", streamId: "stream_1" } as never)
  })

  test("persists the canonical descriptionJson plus its derived markdown and emits stream:updated", async () => {
    const stream = { id: "stream_1", workspaceId: "ws_1" } as never
    mockUpdate.mockResolvedValue(stream)
    mockFindById.mockResolvedValue(stream)

    await service.updateStream(
      "stream_1",
      {
        descriptionJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "About this channel" }] }],
        },
      },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    expect(mockUpdate).toHaveBeenCalledWith(
      {},
      "stream_1",
      expect.objectContaining({
        description: "About this channel",
        descriptionJson: expect.objectContaining({ type: "doc" }),
      })
    )
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:updated",
      expect.objectContaining({ streamId: "stream_1" })
    )
  })

  test("leaves the description columns untouched when neither field is supplied", async () => {
    const stream = { id: "stream_1", workspaceId: "ws_1" } as never
    mockUpdate.mockResolvedValue(stream)
    mockUpdateDisplayName.mockResolvedValue(stream)
    mockFindById.mockResolvedValue(stream)

    await service.updateStream(
      "stream_1",
      { displayName: "Renamed" },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    const params = mockUpdate.mock.calls[0]![2] as Record<string, unknown>
    expect(params).not.toHaveProperty("description")
    expect(params).not.toHaveProperty("descriptionJson")
  })

  test("appends a description_set timeline event + outbox when an actor changes the description", async () => {
    mockUpdate.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
    const authorityStream = { id: "stream_1", workspaceId: "ws_1", type: "channel", visibility: "private" }
    mockFindById
      .mockResolvedValueOnce(authorityStream as never)
      .mockResolvedValueOnce(authorityStream as never)
      .mockResolvedValueOnce({ ...authorityStream, description: "Old" } as never)
      .mockResolvedValueOnce({ ...authorityStream, description: "New" } as never)

    await service.updateStream(
      "stream_1",
      {
        descriptionJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New" }] }] },
        actorId: "usr_1",
      },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    expect(mockInsertEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        eventType: "description_set",
        payload: { descriptionMarkdown: "New" },
        actorId: "usr_1",
        actorType: "user",
      })
    )
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:description_set",
      expect.objectContaining({ streamId: "stream_1", event: expect.objectContaining({ id: "evt_1" }) })
    )
  })

  test("does not append a description_set event when the markdown is unchanged (no-op re-save)", async () => {
    mockUpdate.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
    mockFindById.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1", description: "Same" } as never)

    await service.updateStream(
      "stream_1",
      {
        descriptionJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Same" }] }] },
        actorId: "usr_1",
      },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    expect(mockInsertEvent).not.toHaveBeenCalled()
  })

  test("does not append a description_set event when no actor is provided", async () => {
    mockUpdate.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1", description: "New" } as never)
    mockFindById.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1", description: "New" } as never)

    await service.updateStream(
      "stream_1",
      {
        descriptionJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New" }] }] },
      },
      { workspaceId: "ws_1", principal: { kind: "user", userId: "usr_1" } }
    )

    expect(mockInsertEvent).not.toHaveBeenCalled()
  })
})

describe("StreamService.createScratchpadInTransaction description", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockInsertStream.mockReset()
    mockInsertMember.mockReset().mockResolvedValue({} as never)
    mockInsertEvent.mockReset().mockResolvedValue({ id: "evt_1", streamId: "stream_pad" } as never)
    mockInsertOutbox.mockReset()
  })

  test("emits a bot-attributed description_set event when created with a description + actor", async () => {
    mockInsertStream.mockResolvedValue({ id: "stream_pad", workspaceId: "ws_1", description: "Handover note" } as never)

    await service.createScratchpadInTransaction(
      {} as never,
      {
        workspaceId: "ws_1",
        displayName: "Session",
        description: "Handover note",
        descriptionActor: { id: "bot_1", type: "bot" },
        createdBy: "usr_owner",
      } as never
    )

    expect(mockInsertEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        eventType: "description_set",
        payload: { descriptionMarkdown: "Handover note" },
        actorId: "bot_1",
        actorType: "bot",
      })
    )
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:description_set",
      expect.objectContaining({ streamId: "stream_pad" })
    )
  })

  test("stores a description without an event when no actor is attributed", async () => {
    mockInsertStream.mockResolvedValue({ id: "stream_pad", workspaceId: "ws_1", description: "Note" } as never)

    await service.createScratchpadInTransaction(
      {} as never,
      {
        workspaceId: "ws_1",
        displayName: "Session",
        description: "Note",
        createdBy: "usr_owner",
      } as never
    )

    expect(mockInsertEvent).not.toHaveBeenCalled()
  })
})

describe("StreamService.updateCompanionMode persona validation", () => {
  let service: StreamService
  const mockPersonaFindById = spyOn(PersonaRepository, "findById")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockUpdate.mockReset()
    mockUpdate.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" } as never)
    mockInsertOutbox.mockClear()
    mockInsertOutbox.mockResolvedValue({} as never)
    mockPersonaFindById.mockReset()
  })

  test("rejects a companionPersonaId that resolves to no active persona", async () => {
    mockPersonaFindById.mockResolvedValue(null)
    await expect(service.updateCompanionMode("stream_1", "ws_1", "on", "persona_gone", "user_1")).rejects.toMatchObject(
      {
        status: 400,
        code: "PERSONA_NOT_AVAILABLE",
      }
    )
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  test("rejects an archived persona", async () => {
    mockPersonaFindById.mockResolvedValue({ id: "persona_x", status: "archived" } as never)
    await expect(service.updateCompanionMode("stream_1", "ws_1", "on", "persona_x", "user_1")).rejects.toMatchObject({
      status: 400,
      code: "PERSONA_NOT_AVAILABLE",
    })
  })

  test("accepts an active persona and writes", async () => {
    mockPersonaFindById.mockResolvedValue({ id: "persona_x", status: "active" } as never)
    await service.updateCompanionMode("stream_1", "ws_1", "on", "persona_x", "user_1")
    expect(mockUpdate).toHaveBeenCalled()
    expect(mockPersonaFindById).toHaveBeenCalledWith(expect.anything(), "persona_x", "ws_1")
  })

  test("clearing (null) skips persona validation", async () => {
    await service.updateCompanionMode("stream_1", "ws_1", "off", null, "user_1")
    expect(mockPersonaFindById).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })
})

describe("StreamService.addBotToStream", () => {
  const mockGrantAccess = spyOn(BotChannelAccessRepository, "grantAccess")
  const mockFindBotById = spyOn(BotRepository, "findByIdForUpdate")
  let service: StreamService

  beforeEach(() => {
    mockFindById.mockReset()
    mockFindBotById.mockReset().mockResolvedValue({
      id: "bot_1",
      workspaceId: "ws_1",
      apiKeyId: null,
      type: "personal",
      ownerUserId: "usr_1",
      traits: [],
      slug: "kris-bot",
      name: "Kris's Bot",
      description: null,
      avatarEmoji: null,
      avatarUrl: null,
      archivedAt: null,
      createdAt: new Date("2026-07-13T00:00:00Z"),
      updatedAt: new Date("2026-07-13T00:00:00Z"),
    } as never)
    mockGrantAccess.mockReset().mockResolvedValue(true)
    mockInsertEvent.mockReset().mockResolvedValue({
      id: "evt_1",
      streamId: "stream_dm",
      sequence: 1n,
      eventType: "member_added",
      payload: {},
      actorId: "bot_1",
      actorType: "bot",
      createdAt: new Date(),
    } as never)
    mockInsertOutbox.mockReset().mockResolvedValue({} as never)
    service = new StreamService({} as never)
  })

  test("grants a bot access to a DM stream (contacts stay immutable, bot participants are addable)", async () => {
    mockFindById.mockResolvedValue({ id: "stream_dm", workspaceId: "ws_1", type: "dm" } as never)

    await service.addBotToStream("stream_dm", "bot_1", "ws_1", "usr_1")

    expect(mockGrantAccess).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workspaceId: "ws_1", botId: "bot_1", streamId: "stream_dm", grantedBy: "usr_1" })
    )
    expect(mockInsertEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ streamId: "stream_dm", eventType: "member_added", actorId: "bot_1", actorType: "bot" })
    )
    expect(mockInsertOutbox).toHaveBeenCalledWith(
      {},
      "stream:member_added",
      expect.objectContaining({
        streamId: "stream_dm",
        memberId: "bot_1",
        // Serialized bot metadata rides the event so members whose roster
        // doesn't hold this personal bot can render the new participant.
        bot: expect.objectContaining({
          id: "bot_1",
          type: "personal",
          ownerUserId: "usr_1",
          name: "Kris's Bot",
          createdAt: "2026-07-13T00:00:00.000Z",
        }),
      })
    )
  })

  test("redirects a thread grant to its root channel", async () => {
    mockFindById
      .mockResolvedValueOnce({
        id: "stream_thread",
        workspaceId: "ws_1",
        type: "thread",
        rootStreamId: "stream_root",
      } as never)
      .mockResolvedValueOnce({
        id: "stream_thread",
        workspaceId: "ws_1",
        type: "thread",
        rootStreamId: "stream_root",
      } as never)
      .mockResolvedValueOnce({ id: "stream_root", workspaceId: "ws_1", type: "channel" } as never)

    await service.addBotToStream("stream_thread", "bot_1", "ws_1", "usr_1")

    expect(mockGrantAccess).toHaveBeenCalledWith({}, expect.objectContaining({ streamId: "stream_root" }))
  })

  test("does not emit events when the grant already exists", async () => {
    mockFindById.mockResolvedValue({ id: "stream_dm", workspaceId: "ws_1", type: "dm" } as never)
    mockGrantAccess.mockResolvedValue(false)

    await service.addBotToStream("stream_dm", "bot_1", "ws_1", "usr_1")

    expect(mockInsertEvent).not.toHaveBeenCalled()
    expect(mockInsertOutbox).not.toHaveBeenCalled()
  })
})

describe("StreamService.createChannel read-state shadow", () => {
  let service: StreamService

  beforeEach(() => {
    service = new StreamService({} as never)
    mockSlugExists.mockReset().mockResolvedValue(false)
    mockInsertStream.mockReset().mockResolvedValue({ id: "stream_new", workspaceId: "ws_1", type: "channel" } as never)
    mockInsertMember.mockReset().mockResolvedValue({} as never)
    mockInsertOutbox.mockReset().mockResolvedValue({} as never)
    mockFindMembersByIds.mockReset().mockResolvedValue([
      { id: "usr_a", workspaceId: "ws_1" },
      { id: "usr_b", workspaceId: "ws_1" },
    ] as never)
    mockInsertManyMembers.mockReset().mockResolvedValue([] as never)
    mockInsertManyEvents.mockReset().mockResolvedValue([{ id: "evt_a" }, { id: "evt_b" }] as never)
    mockInsertManyOutbox.mockReset().mockResolvedValue(undefined as never)
    mockReadStateSetForUsers.mockClear()
  })

  test("born-reads the initial members via setForUsers on the same tx client", async () => {
    await service.createChannel({
      workspaceId: "ws_1",
      slug: "chan",
      createdBy: "usr_owner",
      memberIds: ["usr_owner", "usr_a", "usr_b"],
    } as never)

    // The creator is filtered out of the additional-member batch; the frontier
    // lands on the last creation event.
    expect(mockReadStateSetForUsers).toHaveBeenCalledWith({}, "stream_new", ["usr_a", "usr_b"], "evt_b")
  })
})

describe("StreamService.addMember read-state shadow", () => {
  let service: StreamService
  const mockFindByStreamAndMember = spyOn(StreamMemberRepository, "findByStreamAndMember")
  const mockUpdateMember = spyOn(StreamMemberRepository, "update")
  const mockUserFindById = spyOn(UserRepository, "findById")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset().mockResolvedValue({ id: "stream_1", workspaceId: "ws_1", type: "channel" } as never)
    mockFindByStreamAndMember.mockReset().mockResolvedValue(null)
    mockInsertMember.mockReset().mockResolvedValue({ streamId: "stream_1", memberId: "usr_new" } as never)
    mockInsertEvent.mockReset().mockResolvedValue({
      id: "evt_born",
      streamId: "stream_1",
      sequence: 5n,
      eventType: "member_added",
      payload: {},
      actorId: "usr_new",
      actorType: "user",
      createdAt: new Date(),
    } as never)
    mockUpdateMember.mockReset().mockResolvedValue(undefined as never)
    mockInsertOutbox.mockReset().mockResolvedValue({} as never)
    mockUserFindById.mockReset().mockResolvedValue({ id: "usr_new", workspaceId: "ws_1" } as never)
    mockReadStateAdvance.mockClear()
  })

  test("born-reads the member_added event in standalone read state on the same tx client", async () => {
    await service.addMember("stream_1", "usr_new", "ws_1", "usr_actor")

    const eventCall = mockInsertEvent.mock.calls.find(
      (call) => (call[1] as { eventType?: string }).eventType === "member_added"
    )
    expect(eventCall).toBeDefined()
    const bornReadEventId = (eventCall![1] as { id: string }).id
    expect(bornReadEventId).toBeTruthy()

    const advanceCall = mockReadStateAdvance.mock.calls.find((call) => call[1] === "stream_1" && call[2] === "usr_new")
    expect(advanceCall).toBeDefined()
    expect(advanceCall![0]).toBe(eventCall![0])
    expect(advanceCall![3]).toBe(bornReadEventId)
    expect(mockUpdateMember).not.toHaveBeenCalled()
  })
})
