import { afterAll, describe, test, expect, mock, spyOn, beforeEach } from "bun:test"
import type { PoolClient } from "pg"
import { StreamService } from "./service"
import { StreamRepository } from "./repository"
import { StreamMemberRepository } from "./member-repository"
import { StreamEventRepository } from "./event-repository"
import { OutboxRepository } from "../../lib/outbox"
import { UserRepository } from "../workspaces"
import { MessageRepository } from "../messaging"
import { E2eStreamsRepository, E2eStreamActorsRepository, StreamE2eKeyWrapsRepository } from "../e2e-streams"
import { EnclaveRuntimesRepository } from "../enclave-runtimes"
import { BotRuntimeInstanceRepository, StreamActiveActorRepository } from "../bot-runtimes/repository"
import * as idModule from "../../lib/id"
import * as db from "../../db"
import { HttpError } from "../../lib/errors"

const mockFindById = spyOn(StreamRepository, "findById")
const mockInsertOrFindByUniquenessKey = spyOn(StreamRepository, "insertOrFindByUniquenessKey")
const mockInsertMember = spyOn(StreamMemberRepository, "insert")
const mockInsertManyMembers = spyOn(StreamMemberRepository, "insertMany")
const mockIsMemberForUpdate = spyOn(StreamMemberRepository, "isMemberForUpdate")
const mockInsertEvent = spyOn(StreamEventRepository, "insert")
const mockInsertOutbox = spyOn(OutboxRepository, "insert")
const mockFindMembersByIds = spyOn(UserRepository, "findByIds")
const mockInsertStream = spyOn(StreamRepository, "insert")
const mockMarkStreamE2e = spyOn(E2eStreamsRepository, "markStreamE2e")

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

describe("StreamService.joinPublicChannel", () => {
  let service: StreamService

  beforeEach(() => {
    mockFindById.mockReset()
    mockInsertMember.mockReset().mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      pinned: false,
      pinnedAt: null,
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
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
      archivedAt: new Date(),
    } as never)

    const error = await service
      .resolveWritableMessageStream({
        workspaceId: "ws_1",
        userId: "usr_1",
        target: { streamId: "stream_1" },
      })
      .catch((e) => e)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(403)
    expect((error as HttpError).message).toBe("Cannot send messages to an archived stream")
  })

  test("should throw 403 when member cannot write to stream", async () => {
    spyOn(service, "getStreamById").mockResolvedValue({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "scratchpad",
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
    expect((error as HttpError).message).toBe("Not a member of this stream")
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
    parentMessageId: "msg_1",
    rootStreamId: "stream_channel",
    createdBy: "member_creator",
    createdAt: new Date().toISOString(),
  }

  const mockInsertThreadOrFind = spyOn(StreamRepository, "insertThreadOrFind")
  const mockMessageFindById = spyOn(MessageRepository, "findById")
  const mockIsMember = spyOn(StreamMemberRepository, "isMember")
  const mockFindByStreamAndMember = spyOn(StreamMemberRepository, "findByStreamAndMember")
  const mockUpdateMember = spyOn(StreamMemberRepository, "update")

  beforeEach(() => {
    service = new StreamService({} as never)
    mockFindById.mockReset().mockResolvedValue(parentStream as never)
    mockInsertThreadOrFind.mockReset().mockResolvedValue({ stream: thread, created: true } as never)
    mockIsMember.mockReset().mockResolvedValue(false)
    mockInsertMember.mockReset().mockResolvedValue({
      streamId: thread.id,
      memberId: "member_creator",
      pinned: false,
      pinnedAt: null,
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
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
    mockMessageFindById.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentMessageId: "msg_1",
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

  test("does not emit stream:member_added when author is the thread creator", async () => {
    mockMessageFindById.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_creator",
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentMessageId: "msg_1",
      createdBy: "member_creator",
    })

    const memberAddedCalls = mockInsertOutbox.mock.calls.filter(([, type]) => type === "stream:member_added")
    expect(memberAddedCalls).toHaveLength(0)
  })

  test("does not emit stream:member_added for bot-authored parent messages", async () => {
    mockMessageFindById.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "bot",
      authorId: "bot_1",
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentMessageId: "msg_1",
      createdBy: "member_creator",
    })

    const memberAddedCalls = mockInsertOutbox.mock.calls.filter(([, type]) => type === "stream:member_added")
    expect(memberAddedCalls).toHaveLength(0)
  })

  test("emits stream:created to parent stream room when thread is newly created", async () => {
    mockMessageFindById.mockResolvedValue({
      id: "msg_1",
      streamId: "stream_channel",
      authorType: "user",
      authorId: "member_author",
    } as never)

    await service.create({
      workspaceId: "ws_1",
      type: "thread",
      parentStreamId: "stream_channel",
      parentMessageId: "msg_1",
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
})

describe("StreamService.inviteActor", () => {
  let service: StreamService

  const mockGetByStreamId = spyOn(E2eStreamsRepository, "getByStreamId")
  const mockAddActor = spyOn(E2eStreamActorsRepository, "add")
  const mockFindByIdForWorkspace = spyOn(StreamRepository, "findByIdForWorkspace")
  const mockListForStream = spyOn(E2eStreamActorsRepository, "listForStream")
  const mockListLiveEiks = spyOn(EnclaveRuntimesRepository, "listLive")
  const mockFindActiveActor = spyOn(StreamActiveActorRepository, "findByRootStream")
  const mockFindLiveBiks = spyOn(BotRuntimeInstanceRepository, "findLiveWithKeyForBot")

  const updatedStream = {
    id: "stream_e2e",
    workspaceId: "ws_1",
    type: "scratchpad",
    e2eEnabled: true,
    e2eActors: [{ kind: "enclave", keyId: null }],
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
    // Default: no resolvable actor keys → keyRoll null. Individual tests opt in.
    mockListForStream.mockReset().mockResolvedValue([{ kind: "enclave", keyId: null }])
    mockListLiveEiks.mockReset().mockResolvedValue([])
    mockFindActiveActor.mockReset().mockResolvedValue(null)
    mockFindLiveBiks.mockReset().mockResolvedValue([])
  })

  test("adds the enclave actor, emits stream:updated, and returns null keyRoll when no live key exists", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)

    const result = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "enclave")

    expect(mockAddActor).toHaveBeenCalledWith({}, "ws_1", "stream_e2e", "enclave", null)
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

  test("resolves a bot's live BIKs via the active-actor row", async () => {
    mockGetByStreamId.mockResolvedValue(ownedE2eStream)
    mockListForStream.mockResolvedValue([{ kind: "bot", keyId: null }])
    mockFindActiveActor.mockResolvedValue({ actorType: "bot", actorId: "bot_pi" } as never)
    mockFindLiveBiks.mockResolvedValue([{ publicKey: "Ymlr", publicKeyId: "bik_1" }] as never)

    const result = await service.inviteActor("ws_1", "stream_e2e", "usr_owner", "bot")

    expect(mockFindLiveBiks).toHaveBeenCalledWith({}, expect.objectContaining({ botId: "bot_pi" }))
    expect(result.keyRoll).toEqual({
      nextGeneration: 1,
      recipients: [{ recipientKeyId: "bik_1", recipientKind: "bot", publicKey: "Ymlr" }],
    })
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

  test("throws 409 when that actor kind is already invited", async () => {
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
})
