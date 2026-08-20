import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { CallService } from "./service"
import {
  CallRepository,
  CallInvitationRepository,
  CallParticipantRepository,
  CallEndpointRepository,
  type Call,
  type CallParticipant,
  type CallEndpoint,
} from "./repository"
import * as accessModule from "./access"
import * as streamsModule from "../streams"
import * as workspacesModule from "../workspaces"
import * as activityModule from "../activity"
import * as dbModule from "../../db"
import * as observabilityModule from "../../lib/observability"
import { OutboxRepository } from "../../lib/outbox"
import { CALL_PRODUCT_CAP } from "./config"
import { CloudflareRealtimeError, summarizeSdpMSections } from "./cloudflare"

const NOW = new Date("2026-07-19T12:00:00.000Z")

function fakeCall(overrides: Partial<Call> = {}): Call {
  return {
    id: "call_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    startedBy: "usr_a",
    status: "active",
    mode: "video",
    mediaTransport: "sfu",
    chatStreamId: null,
    sharingEndpointId: null,
    rosterVersion: 0,
    graceDeadline: null,
    endedReason: null,
    startedAt: NOW,
    endedAt: null,
    statusChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function fakeParticipant(overrides: Partial<CallParticipant> = {}): CallParticipant {
  return {
    id: "callp_1",
    workspaceId: "ws_1",
    callId: "call_1",
    userId: "usr_a",
    status: "joined",
    invitedBy: null,
    removedBy: null,
    joinedAt: NOW,
    leftAt: null,
    statusChangedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function fakeEndpoint(overrides: Partial<CallEndpoint> = {}): CallEndpoint {
  return {
    id: "callep_1",
    workspaceId: "ws_1",
    callId: "call_1",
    participantId: "callp_1",
    epoch: 1,
    connectionSeq: 0,
    status: "connected",
    cfSessionId: null,
    mediaIncarnation: null,
    mediaState: {},
    publishedTracks: [],
    leaseExpiresAt: NOW,
    createdAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function stubTransaction() {
  // The client carries a no-op `query` so unspied same-tx statements (the roster
  // bumps every membership/connection transition now runs) don't throw; each test
  // that cares spies CallRepository.bumpRosterVersion(Batch) directly and asserts.
  const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn(client))
  // Ring lifecycle now emits outbox events in-tx; stub the insert so unspied
  // emissions don't hit the no-op client (which would map an empty row set).
  spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)
  spyOn(workspacesModule.UserRepository, "findById").mockResolvedValue({ id: "usr_a", name: "Ada" } as never)
  // call_started/call_ended timeline appends (1.4) run in the same tx; stub the
  // event insert + member lookup so unspied appends don't hit the no-op client
  // (StreamEventRepository.insert reads back a sequence row that isn't there).
  spyOn(streamsModule.StreamEventRepository, "insert").mockResolvedValue({ id: "evt_1" } as never)
  spyOn(streamsModule.StreamMemberRepository, "list").mockResolvedValue([])
}

function makeService() {
  return new CallService({ pool: {} as Pool })
}

/** Stub the endpoint-admission reads for a clean first join (no live endpoint, epoch 0). */
function stubCleanEndpointAdmission(endpoint = fakeEndpoint()) {
  spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(null)
  spyOn(CallEndpointRepository, "maxEpochForParticipant").mockResolvedValue(0)
  const insert = spyOn(CallEndpointRepository, "insert").mockResolvedValue(endpoint)
  return { insert }
}

describe("CallService.startCall — product glare", () => {
  afterEach(() => mock.restore())

  it("the winner creates the call and is admitted with a leased endpoint (created=true)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    const admit = spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    const { insert } = stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
      mode: "video",
    })

    expect(result).toMatchObject({ created: true, call: { id: "call_1" }, endpoint: { id: "callep_1" } })
    // The freshly-appended `call_started` event is the chat-thread anchor handed
    // back to the client (stubbed StreamEventRepository.insert → { id: "evt_1" }).
    expect(result.chatAnchorId).toBe("evt_1")
    expect(admit).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("the loser re-reads the winning call and is still admitted (created=false)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    const findOpen = spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall({ id: "call_winner" }))
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ id: "call_winner" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    const admit = spyOn(CallParticipantRepository, "admit").mockResolvedValue(
      fakeParticipant({ callId: "call_winner" })
    )
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    // A join onto an existing call appends no new card — the chat anchor is the
    // pre-existing `call_started` event, resolved by id from the host stream.
    const findAnchor = spyOn(CallRepository, "findCallStartedEventId").mockResolvedValue("event_existing")

    const result = await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_b",
      mode: "video",
    })

    expect(result).toMatchObject({ created: false, call: { id: "call_winner" } })
    expect(result.chatAnchorId).toBe("event_existing")
    expect(findAnchor).toHaveBeenCalledWith(expect.anything(), "stream_1", "call_winner")
    expect(findOpen).toHaveBeenCalledTimes(1)
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it("start into an empty_grace call revives it (no wedge, same locked join path)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    const revive = spyOn(CallRepository, "reviveFromGrace").mockResolvedValue(fakeCall({ status: "active" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
      mode: "video",
    })

    expect(revive).toHaveBeenCalledTimes(1)
    expect(result.call.status).toBe("active")
  })

  it("start as join past the cap rejects with CALL_FULL", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(CALL_PRODUCT_CAP)

    await expect(
      makeService().startCall({ workspaceId: "ws_1", streamId: "stream_1", userId: "usr_51", mode: "video" })
    ).rejects.toMatchObject({ code: "CALL_FULL", status: 409 })
  })
})

describe("CallService.startCall — DM ring", () => {
  afterEach(() => mock.restore())

  it("rings the DM peer with a fresh ringing invitation", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({ target: { id: "stream_dm", type: "dm" } } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_dm", type: "dm" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(fakeCall({ streamId: "stream_dm" }))
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ streamId: "stream_dm" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    spyOn(streamsModule.StreamMemberRepository, "list").mockResolvedValue([
      { memberId: "usr_a" } as never,
      { memberId: "usr_peer" } as never,
    ])
    const ring = spyOn(CallInvitationRepository, "insertRinging").mockResolvedValue({
      id: "callinv_1",
      expiresAt: NOW,
    } as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().startCall({ workspaceId: "ws_1", streamId: "stream_dm", userId: "usr_a", mode: "audio_only" })

    expect(ring).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inviteeUserId: "usr_peer", inviterUserId: "usr_a", callId: "call_1" })
    )
    // The ring reaches the invitee (INV-4): user-scoped created event in the same tx.
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_created",
      expect.objectContaining({
        targetUserId: "usr_peer",
        attemptId: "callinv_1",
        callId: "call_1",
        mode: "audio_only",
      })
    )
  })

  it("does not ring when joining an already-active DM call (created=false)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({ target: { id: "stream_dm", type: "dm" } } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_dm", type: "dm" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall({ streamId: "stream_dm" }))
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ streamId: "stream_dm" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    const ring = spyOn(CallInvitationRepository, "insertRinging").mockResolvedValue({} as never)

    await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_dm",
      userId: "usr_peer",
      mode: "audio_only",
    })

    expect(ring).not.toHaveBeenCalled()
  })

  it("rejects a start the user cannot access", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockRejectedValue(
      Object.assign(new Error("Stream not found"), { status: 404, code: "STREAM_NOT_FOUND" })
    )

    await expect(
      makeService().startCall({ workspaceId: "ws_1", streamId: "stream_x", userId: "usr_a", mode: "video" })
    ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND", status: 404 })
  })
})

describe("CallService.joinCall — revive, capacity, membership", () => {
  afterEach(() => mock.restore())

  it("revives an empty_grace call and accepts a ringing invitation on join", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall({ status: "empty_grace" }) })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    const revive = spyOn(CallRepository, "reviveFromGrace").mockResolvedValue(fakeCall({ status: "active" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    stubCleanEndpointAdmission()
    const accept = spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([
      { id: "callinv_1", workspaceId: "ws_1", callId: "call_1", inviteeUserId: "usr_b" } as never,
    ])
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_b" })

    expect(revive).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inviteeUserId: "usr_b" }))
    // A join bumps the roster version in the same tx (INV-66) so peers don't drop the arrival.
    expect(bump).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
    // Accepting the ring on join settles it across the invitee's devices.
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ targetUserId: "usr_b", attemptId: "callinv_1", outcome: "accepted" })
    )
    expect(result.endpoint.id).toBe("callep_1")
  })

  it("rejects join #51 with CALL_FULL", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(CALL_PRODUCT_CAP)

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_51" })
    ).rejects.toMatchObject({ code: "CALL_FULL", status: 409 })
  })

  it("rejects a removed participant's self-rejoin", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(null)

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_removed" })
    ).rejects.toMatchObject({ code: "CALL_PARTICIPANT_REMOVED", status: 403 })
  })

  it("lets a left participant rejoin", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant({ userId: "usr_rejoin" }))
    const { insert } = stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_rejoin" })

    expect(result.participant.userId).toBe("usr_rejoin")
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("rejects joining an ended call", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall({ status: "ended" }) })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ status: "ended" }))

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_b" })
    ).rejects.toMatchObject({ code: "CALL_ENDED", status: 409 })
  })

  it("rejects a join with no call access", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue(null)

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_x", userId: "usr_b" })
    ).rejects.toMatchObject({ code: "CALL_NOT_FOUND", status: 404 })
  })
})

describe("CallService.joinCall — second endpoint / takeover", () => {
  afterEach(() => mock.restore())

  it("rejects a second live endpoint without takeover", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3 })
    )

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a" })
    ).rejects.toMatchObject({ code: "CALL_ENDPOINT_ACTIVE", status: 409 })
  })

  it("takeover closes the old endpoint and mints epoch max+1", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3 })
    )
    const close = spyOn(CallEndpointRepository, "close").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", status: "closed" })
    )
    spyOn(CallEndpointRepository, "maxEpochForParticipant").mockResolvedValue(3)
    const insert = spyOn(CallEndpointRepository, "insert").mockResolvedValue(
      fakeEndpoint({ id: "callep_new", epoch: 4 })
    )
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      takeover: true,
    })

    expect(close).toHaveBeenCalledWith(expect.anything(), "ws_1", "callep_old")
    expect(insert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ epoch: 4 }))
    expect(result.endpoint.id).toBe("callep_new")
  })

  it("closes the superseded endpoint's CF session after a takeover commit (S3)", async () => {
    stubTransaction()
    const order: string[] = []
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3, cfSessionId: "sess_old" })
    )
    spyOn(CallEndpointRepository, "close").mockImplementation(async () => {
      order.push("db-close")
      return fakeEndpoint({ id: "callep_old", cfSessionId: "sess_old", status: "closed" })
    })
    spyOn(CallEndpointRepository, "maxEpochForParticipant").mockResolvedValue(3)
    spyOn(CallEndpointRepository, "insert").mockResolvedValue(fakeEndpoint({ id: "callep_new", epoch: 4 }))
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    const closeSession = mock(async () => {
      order.push("cf-close")
    })

    await makeServiceWithCf({ closeSession }).joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      takeover: true,
    })

    // The dropped device's CF session is torn down after the join commits (S3, INV-41).
    expect(closeSession).toHaveBeenCalledWith("sess_old")
    expect(order).toEqual(["db-close", "cf-close"])
  })

  it("reports the displaced endpoint on a takeover and nothing on a rebind", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3, mediaIncarnation: "inc_other" })
    )
    spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ id: "callep_old", status: "closed" }))
    spyOn(CallEndpointRepository, "maxEpochForParticipant").mockResolvedValue(3)
    spyOn(CallEndpointRepository, "insert").mockResolvedValue(fakeEndpoint({ id: "callep_new", epoch: 4 }))
    const rebind = spyOn(CallEndpointRepository, "rebind").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3 })
    )

    const service = makeService()
    const takenOver = await service.joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      mediaIncarnation: "inc_new",
      takeover: true,
    })
    // A rebind reuses the endpoint id, so the "another device took this over"
    // notification would land on the arriving device — it must report nothing.
    const rebound = await service.joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      mediaIncarnation: "inc_other",
    })

    expect(rebind).toHaveBeenCalled()
    expect({ takeover: takenOver.supersededEndpointId, rebind: rebound.supersededEndpointId }).toEqual({
      takeover: "callep_old",
      rebind: null,
    })
  })
})

describe("CallService.startCall — takeover", () => {
  afterEach(() => mock.restore())

  it("forwards takeover into the locked join so a second device can displace the first", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findCallStartedEventId").mockResolvedValue("evt_started")
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3, mediaIncarnation: "inc_phone" })
    )
    const close = spyOn(CallEndpointRepository, "close").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", status: "closed" })
    )
    spyOn(CallEndpointRepository, "maxEpochForParticipant").mockResolvedValue(3)
    spyOn(CallEndpointRepository, "insert").mockResolvedValue(fakeEndpoint({ id: "callep_new", epoch: 4 }))

    // The client only ever reaches admitEndpoint through REST start, so without
    // this forwarding "Join on this device" is unreachable.
    const result = await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
      mode: "video",
      mediaIncarnation: "inc_laptop",
      takeover: true,
    })

    expect(close).toHaveBeenCalledWith(expect.anything(), "ws_1", "callep_old")
    expect({ endpointId: result.endpoint.id, superseded: result.supersededEndpointId }).toEqual({
      endpointId: "callep_new",
      superseded: "callep_old",
    })
  })

  it("still rejects a second device when takeover is not asked for", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 3, mediaIncarnation: "inc_phone" })
    )

    await expect(
      makeService().startCall({
        workspaceId: "ws_1",
        streamId: "stream_1",
        userId: "usr_a",
        mode: "video",
        mediaIncarnation: "inc_laptop",
      })
    ).rejects.toMatchObject({ code: "CALL_ENDPOINT_ACTIVE", status: 409 })
  })
})

describe("CallService.leaveCall", () => {
  afterEach(() => mock.restore())

  it("ends an emptied call IN-TX on an explicit last-leave (skips grace) and appends stream:call_ended", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    const close = spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    const markLeft = spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(
      fakeParticipant({ status: "left" })
    )
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(null)
    const end = spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(
      fakeCall({ status: "ended", endedReason: "completed", endedAt: NOW })
    )
    // appendCallEndedForLeave's ctx reads (stream visibility + ever-participant set).
    spyOn(streamsModule.StreamRepository, "findById").mockResolvedValue({ visibility: "public" } as never)
    spyOn(CallParticipantRepository, "listUserIdsByCall").mockResolvedValue(new Map([["call_1", ["usr_a"]]]))
    spyOn(CallInvitationRepository, "cancelRingingForCall").mockResolvedValue([])
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ status: "ended", endedReason: "completed" }))
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().leaveCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      endpointId: "callep_1",
    })

    expect(close).toHaveBeenCalledWith(expect.anything(), "ws_1", "callep_1")
    expect(markLeft).toHaveBeenCalledTimes(1)
    // The explicit last-leave ends the call directly — grace is only for the reaper path.
    expect(end).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "completed" }))
    expect(grace).not.toHaveBeenCalled()
    // The end summary rides the outbox in the same tx (INV-4/7) so peers see the ended card.
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "stream:call_ended",
      expect.objectContaining({ callId: "call_1", streamId: "stream_1" })
    )
    // A leave bumps the roster version in the same tx (INV-66) so the departed tile isn't a ghost.
    expect(bump).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
    expect(result.call.status).toBe("ended")
  })

  it("a lost end CAS (concurrent join / double last-leave) appends no call_ended and does not throw", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    // The CAS loses the row (a concurrent join revived it, or a sibling leave ended it first).
    const end = spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(null)
    const streamRead = spyOn(streamsModule.StreamRepository, "findById").mockResolvedValue({
      visibility: "public",
    } as never)
    spyOn(CallInvitationRepository, "cancelRingingForCall").mockResolvedValue([])
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })

    expect(end).toHaveBeenCalledTimes(1)
    // No ended row → no summary read, no call_ended emit (the winner already emitted it).
    expect(streamRead).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalledWith(expect.anything(), "stream:call_ended", expect.anything())
  })

  it("does not end a call that still has joined participants", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(2)
    const end = spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(null)
    spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([])
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())

    await makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })

    expect(end).not.toHaveBeenCalled()
  })

  it("rejects closing an endpoint owned by another participant", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint({ participantId: "callp_other" }))
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ id: "callp_1" }))
    const close = spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))

    await expect(
      makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_other" })
    ).rejects.toMatchObject({ code: "CALL_NOT_PARTICIPANT", status: 403 })
    expect(close).not.toHaveBeenCalled()
  })

  it("rejects closing an endpoint from a different call", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint({ callId: "call_other" }))
    const close = spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))

    await expect(
      makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })
    ).rejects.toMatchObject({ code: "CALL_ENDPOINT_NOT_FOUND", status: 404 })
    expect(close).not.toHaveBeenCalled()
  })

  it("cancels the outstanding ring when the inviter hangs up before an answer (no missed call)", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(fakeCall({ status: "ended", endedReason: "completed" }))
    spyOn(streamsModule.StreamRepository, "findById").mockResolvedValue({ visibility: "public" } as never)
    spyOn(CallParticipantRepository, "listUserIdsByCall").mockResolvedValue(new Map([["call_1", ["usr_a"]]]))
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ status: "ended", endedReason: "completed" }))
    const cancelAll = spyOn(CallInvitationRepository, "cancelRingingForCall").mockResolvedValue([
      { id: "callinv_1", workspaceId: "ws_1", callId: "call_1", inviteeUserId: "usr_peer", inviterUserId: "usr_a" },
    ] as never)
    const activityInsert = spyOn(activityModule.ActivityRepository, "insert").mockResolvedValue({} as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })

    expect(cancelAll).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1" }))
    // The retracted ring settles as cancelled to the invitee in the same tx (INV-7).
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ targetUserId: "usr_peer", attemptId: "callinv_1", outcome: "cancelled" })
    )
    // A cancelled ring never lapses to expired → no missed-call activity is created.
    expect(activityInsert).not.toHaveBeenCalled()
  })

  it("cancels the leaving inviter's ring even when other participants remain", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(2)
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    const end = spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(null)
    const cancelByInviter = spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([
      { id: "callinv_2", workspaceId: "ws_1", callId: "call_1", inviteeUserId: "usr_peer", inviterUserId: "usr_a" },
    ] as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })

    // The call lives on (others remain) — only the leaver's own ring is retracted, never ended.
    expect(end).not.toHaveBeenCalled()
    expect(cancelByInviter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call_1", inviterUserId: "usr_a" })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ attemptId: "callinv_2", outcome: "cancelled" })
    )
  })

  it("closes the leaving endpoint's CF session exactly once, after the write path (S3)", async () => {
    stubTransaction()
    const order: string[] = []
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint({ cfSessionId: "sess_x" }))
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "close").mockImplementation(async () => {
      order.push("db-close")
      return fakeEndpoint({ cfSessionId: "sess_x", status: "closed" })
    })
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(2)
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([])
    const closeSession = mock(async () => {
      order.push("cf-close")
    })

    await makeServiceWithCf({ closeSession }).leaveCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      endpointId: "callep_1",
    })

    // The CF session dies with the endpoint — closed after the DB write commits (INV-41).
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith("sess_x")
    expect(order).toEqual(["db-close", "cf-close"])
  })
})

describe("CallService.leaveCallAsUser", () => {
  afterEach(() => mock.restore())

  it("is a no-op on an ended call — never emits participants_changed for a dead call", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ status: "ended" }))
    const findByUser = spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    const closeByParticipant = spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([])
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().leaveCallAsUser({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a" })

    expect(result.call.status).toBe("ended")
    // Terminal call: return before any endpoint churn or roster fan-out so a dead
    // card can't flip back to live on peers still holding the id.
    expect(findByUser).not.toHaveBeenCalled()
    expect(closeByParticipant).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it("ends the emptied call in-tx on an explicit last-leave and emits stream:call_ended + participants_changed", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    const closeByParticipant = spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([])
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(null)
    const end = spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(
      fakeCall({ status: "ended", endedReason: "completed", endedAt: NOW })
    )
    spyOn(streamsModule.StreamRepository, "findById").mockResolvedValue({ visibility: "public" } as never)
    spyOn(CallParticipantRepository, "listUserIdsByCall").mockResolvedValue(new Map([["call_1", ["usr_a"]]]))
    spyOn(CallInvitationRepository, "cancelRingingForCall").mockResolvedValue([])
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ status: "ended", endedReason: "completed" }))
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().leaveCallAsUser({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a" })

    expect(closeByParticipant).toHaveBeenCalledWith(expect.anything(), "ws_1", "callp_1")
    expect(end).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "completed" }))
    expect(grace).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "stream:call_ended",
      expect.objectContaining({ callId: "call_1", streamId: "stream_1" })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:participants_changed",
      expect.objectContaining({ callId: "call_1" })
    )
  })

  it("closes each reaped endpoint's CF session after commit, skipping session-less ones (S3)", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([
      fakeEndpoint({ id: "callep_a", cfSessionId: "sess_a", status: "closed" }),
      fakeEndpoint({ id: "callep_b", cfSessionId: null, status: "closed" }),
    ])
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(2)
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([])
    const closeSession = mock(async () => {})

    await makeServiceWithCf({ closeSession }).leaveCallAsUser({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
    })

    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith("sess_a")
  })
})

describe("CallService.renewEndpointLease — fencing", () => {
  afterEach(() => mock.restore())

  it("renews a live lease on a matching epoch", async () => {
    const renew = spyOn(CallEndpointRepository, "renewLease").mockResolvedValue(fakeEndpoint({ epoch: 4 }))

    const result = await makeService().renewEndpointLease({ workspaceId: "ws_1", endpointId: "callep_1", epoch: 4 })

    expect(result?.epoch).toBe(4)
    expect(renew).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ epoch: 4 }))
  })

  it("is a no-op (null) on a stale epoch", async () => {
    spyOn(CallEndpointRepository, "renewLease").mockResolvedValue(null)

    const result = await makeService().renewEndpointLease({ workspaceId: "ws_1", endpointId: "callep_1", epoch: 3 })

    expect(result).toBeNull()
  })
})

describe("CallService.removeParticipant", () => {
  afterEach(() => mock.restore())

  it("removes a target and closes their endpoints when the remover is joined", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ userId: "usr_remover" }))
    const remove = spyOn(CallParticipantRepository, "remove").mockResolvedValue(
      fakeParticipant({ id: "callp_target", userId: "usr_target", status: "removed", removedBy: "usr_remover" })
    )
    const closeEp = spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([])
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)

    const result = await makeService().removeParticipant({
      workspaceId: "ws_1",
      callId: "call_1",
      byUserId: "usr_remover",
      targetUserId: "usr_target",
    })

    expect(remove).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetUserId: "usr_target", removedBy: "usr_remover" })
    )
    expect(closeEp).toHaveBeenCalledWith(expect.anything(), "ws_1", "callp_target")
    // Removal bumps the roster version in the same tx (INV-66).
    expect(bump).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
    expect(result.status).toBe("removed")
  })

  it("rejects a remover who is not a joined participant", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ status: "left" }))

    await expect(
      makeService().removeParticipant({
        workspaceId: "ws_1",
        callId: "call_1",
        byUserId: "usr_x",
        targetUserId: "usr_target",
      })
    ).rejects.toMatchObject({ code: "CALL_NOT_PARTICIPANT", status: 403 })
  })

  it("cancels the removed user's own outstanding ring while the call lives on", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ userId: "usr_remover" }))
    spyOn(CallParticipantRepository, "remove").mockResolvedValue(
      fakeParticipant({ id: "callp_target", userId: "usr_target", status: "removed", removedBy: "usr_remover" })
    )
    spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([])
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(null)
    const cancelByInviter = spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([
      {
        id: "callinv_3",
        workspaceId: "ws_1",
        callId: "call_1",
        inviteeUserId: "usr_peer",
        inviterUserId: "usr_target",
      },
    ] as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().removeParticipant({
      workspaceId: "ws_1",
      callId: "call_1",
      byUserId: "usr_remover",
      targetUserId: "usr_target",
    })

    // The call lives on (others remain) — only the removed user's own ring is retracted.
    expect(grace).not.toHaveBeenCalled()
    expect(cancelByInviter).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "call_1", inviterUserId: "usr_target" })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ attemptId: "callinv_3", outcome: "cancelled" })
    )
  })

  it("cancels every outstanding ring when the removal empties the call", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ userId: "usr_remover" }))
    spyOn(CallParticipantRepository, "remove").mockResolvedValue(
      fakeParticipant({ id: "callp_target", userId: "usr_target", status: "removed", removedBy: "usr_remover" })
    )
    spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([])
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    const cancelAll = spyOn(CallInvitationRepository, "cancelRingingForCall").mockResolvedValue([
      {
        id: "callinv_4",
        workspaceId: "ws_1",
        callId: "call_1",
        inviteeUserId: "usr_peer",
        inviterUserId: "usr_remover",
      },
    ] as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().removeParticipant({
      workspaceId: "ws_1",
      callId: "call_1",
      byUserId: "usr_remover",
      targetUserId: "usr_target",
    })

    expect(grace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "completed" }))
    expect(cancelAll).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callId: "call_1" }))
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ targetUserId: "usr_peer", attemptId: "callinv_4", outcome: "cancelled" })
    )
  })

  it("closes the removed participant's CF sessions after commit (S3)", async () => {
    stubTransaction()
    const order: string[] = []
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ userId: "usr_remover" }))
    spyOn(CallParticipantRepository, "remove").mockResolvedValue(
      fakeParticipant({ id: "callp_target", userId: "usr_target", status: "removed", removedBy: "usr_remover" })
    )
    spyOn(CallEndpointRepository, "closeByParticipant").mockImplementation(async () => {
      order.push("db-close")
      return [fakeEndpoint({ id: "callep_t", cfSessionId: "sess_t", status: "closed" })]
    })
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([])
    const closeSession = mock(async () => {
      order.push("cf-close")
    })

    await makeServiceWithCf({ closeSession }).removeParticipant({
      workspaceId: "ws_1",
      callId: "call_1",
      byUserId: "usr_remover",
      targetUserId: "usr_target",
    })

    expect(closeSession).toHaveBeenCalledWith("sess_t")
    expect(order).toEqual(["db-close", "cf-close"])
  })
})

describe("CallService invitations", () => {
  afterEach(() => mock.restore())

  it("declineInvitation returns the declined ring and settles it to the invitee", async () => {
    stubTransaction()
    spyOn(CallInvitationRepository, "decline").mockResolvedValue({
      id: "callinv_1",
      status: "declined",
      workspaceId: "ws_1",
      callId: "call_1",
      inviteeUserId: "usr_peer",
    } as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    const result = await makeService().declineInvitation({
      workspaceId: "ws_1",
      invitationId: "callinv_1",
      userId: "usr_peer",
    })

    expect(result).toMatchObject({ status: "declined" })
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ targetUserId: "usr_peer", attemptId: "callinv_1", outcome: "declined" })
    )
  })

  it("cancelInvitation settles the ring to the invitee as cancelled", async () => {
    stubTransaction()
    spyOn(CallInvitationRepository, "cancel").mockResolvedValue({
      id: "callinv_1",
      status: "cancelled",
      workspaceId: "ws_1",
      callId: "call_1",
      inviteeUserId: "usr_peer",
    } as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().cancelInvitation({ workspaceId: "ws_1", invitationId: "callinv_1", userId: "usr_a" })

    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ targetUserId: "usr_peer", attemptId: "callinv_1", outcome: "cancelled" })
    )
  })

  it("declineInvitation throws when the ring is no longer ringing", async () => {
    stubTransaction()
    spyOn(CallInvitationRepository, "decline").mockResolvedValue(null)

    await expect(
      makeService().declineInvitation({ workspaceId: "ws_1", invitationId: "callinv_1", userId: "usr_peer" })
    ).rejects.toMatchObject({ code: "CALL_INVITATION_NOT_ACTIONABLE", status: 409 })
  })
})

describe("CallService sweeps", () => {
  afterEach(() => mock.restore())

  it("reapLapsedEndpoints locks calls before closing endpoints, then cascades, returning counts", async () => {
    stubTransaction()
    const order: string[] = []
    spyOn(CallEndpointRepository, "findLapsedCallIds").mockResolvedValue(["call_1"])
    const lock = spyOn(CallRepository, "lockForUpdateInOrder").mockImplementation(async () => {
      order.push("lock")
    })
    spyOn(CallEndpointRepository, "reapLapsed").mockImplementation(async () => {
      order.push("reap")
      return [
        fakeEndpoint({ id: "callep_a", participantId: "callp_a", callId: "call_1", status: "closed" }),
        fakeEndpoint({ id: "callep_b", participantId: "callp_b", callId: "call_1", status: "closed" }),
      ]
    })
    const markLeft = spyOn(CallParticipantRepository, "markLeftWhereNoLiveEndpoint").mockResolvedValue([
      fakeParticipant({ id: "callp_a", status: "left" }),
    ])
    const grace = spyOn(CallRepository, "enterGraceIfEmptyBatch").mockResolvedValue([
      fakeCall({ status: "empty_grace" }),
    ])
    // Disconnect-driven emptiness must NOT take the explicit-leave immediate-end path.
    const end = spyOn(CallRepository, "endActiveIfEmpty").mockResolvedValue(null)
    const bumpBatch = spyOn(CallRepository, "bumpRosterVersionBatch").mockResolvedValue(undefined)

    const result = await makeService().reapLapsedEndpoints(NOW)

    expect(result).toEqual({ endpoints: 2, participants: 1, calls: 1 })
    // Call lock precedes the endpoint close — the fix for the endpoint→call AB-BA deadlock.
    expect(order).toEqual(["lock", "reap"])
    expect(lock).toHaveBeenCalledWith(expect.anything(), ["call_1"])
    expect(markLeft).toHaveBeenCalledWith(expect.anything(), ["callp_a", "callp_b"])
    expect(grace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callIds: ["call_1"] }))
    // The reaper keeps the grace window (its reconnect buffer) — never ends in-tx.
    expect(end).not.toHaveBeenCalled()
    // The reap cascade bumps the roster version of every touched call in the same tx (INV-66).
    expect(bumpBatch).toHaveBeenCalledWith(expect.anything(), ["call_1"])
  })

  it("reapLapsedEndpoints short-circuits before locking when nothing lapsed", async () => {
    stubTransaction()
    spyOn(CallEndpointRepository, "findLapsedCallIds").mockResolvedValue([])
    const lock = spyOn(CallRepository, "lockForUpdateInOrder").mockResolvedValue(undefined)
    const reap = spyOn(CallEndpointRepository, "reapLapsed").mockResolvedValue([])
    const markLeft = spyOn(CallParticipantRepository, "markLeftWhereNoLiveEndpoint").mockResolvedValue([])

    const result = await makeService().reapLapsedEndpoints(NOW)

    expect(result).toEqual({ endpoints: 0, participants: 0, calls: 0 })
    expect(lock).not.toHaveBeenCalled()
    expect(reap).not.toHaveBeenCalled()
    expect(markLeft).not.toHaveBeenCalled()
  })

  it("expireStaleRings and endGraceExpiredCalls return their counts", async () => {
    stubTransaction()
    spyOn(CallInvitationRepository, "expireStaleRings").mockResolvedValue([{ id: "callinv_1" } as never])
    spyOn(CallRepository, "endGraceExpired").mockResolvedValue([fakeCall({ status: "ended" })])
    spyOn(CallRepository, "findById").mockResolvedValue(null)

    expect(await makeService().expireStaleRings(NOW)).toEqual({ expired: 1 })
    expect(await makeService().endGraceExpiredCalls(NOW)).toEqual({ ended: 1 })
  })

  it("expireStaleRings settles each ring and lands a missed-call activity for the invitee", async () => {
    stubTransaction()
    spyOn(CallInvitationRepository, "expireStaleRings").mockResolvedValue([
      { id: "callinv_1", workspaceId: "ws_1", callId: "call_1", inviteeUserId: "usr_peer", inviterUserId: "usr_a" },
    ] as never)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ streamId: "stream_dm", mode: "audio_only" }))
    const activityInsert = spyOn(activityModule.ActivityRepository, "insert").mockResolvedValue({
      id: "act_1",
      activityType: "missed_call",
      streamId: "stream_dm",
      messageId: null,
      actorId: "usr_a",
      actorType: "user",
      context: {},
      createdAt: NOW,
      isSelf: false,
      emoji: null,
    } as never)
    spyOn(activityModule.ActivityRepository, "countUnreadForPairs").mockResolvedValue(new Map())
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().expireStaleRings(NOW)

    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:invitation_settled",
      expect.objectContaining({ targetUserId: "usr_peer", attemptId: "callinv_1", outcome: "expired" })
    )
    expect(activityInsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activityType: "missed_call", userId: "usr_peer", streamId: "stream_dm" })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "activity:created",
      expect.objectContaining({ targetUserId: "usr_peer" })
    )
  })

  it("reapLapsedEndpoints closes the CF sessions of reaped endpoints AFTER commit", async () => {
    stubTransaction()
    spyOn(CallEndpointRepository, "findLapsedCallIds").mockResolvedValue(["call_1"])
    spyOn(CallRepository, "lockForUpdateInOrder").mockResolvedValue(undefined)
    spyOn(CallEndpointRepository, "reapLapsed").mockResolvedValue([
      fakeEndpoint({ id: "callep_a", cfSessionId: "sess_a", status: "closed" }),
      fakeEndpoint({ id: "callep_b", cfSessionId: null, status: "closed" }),
    ])
    spyOn(CallParticipantRepository, "markLeftWhereNoLiveEndpoint").mockResolvedValue([])
    spyOn(CallRepository, "enterGraceIfEmptyBatch").mockResolvedValue([])
    const closeSession = mock(async () => {})

    await makeServiceWithCf({ closeSession }).reapLapsedEndpoints(NOW)

    // Only the endpoint that carried a CF session is torn down.
    expect(closeSession).toHaveBeenCalledTimes(1)
    expect(closeSession).toHaveBeenCalledWith("sess_a")
  })
})

describe("CallService — call_started / call_ended timeline (1.4)", () => {
  afterEach(() => mock.restore())

  it("appends a call_started row + stream:call_started outbox + participants_changed when a call is created", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel", visibility: "public" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({
      id: "stream_1",
      type: "channel",
      visibility: "public",
    } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([
      { userId: "usr_a", endpointId: "callep_1" },
    ] as never)
    const eventInsert = spyOn(streamsModule.StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_started",
    } as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().startCall({ workspaceId: "ws_1", streamId: "stream_1", userId: "usr_a", mode: "video" })

    expect(eventInsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "call_started",
        payload: expect.objectContaining({ callId: "call_1", mode: "video", startedBy: "usr_a" }),
      })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "stream:call_started",
      expect.objectContaining({ callId: "call_1", streamId: "stream_1", streamVisibility: "public" })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:participants_changed",
      expect.objectContaining({ callId: "call_1", participantCount: 1, participantUserIds: ["usr_a"] })
    )
  })

  it("appends NO call_started row when joining an existing call (created=false)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({
      id: "stream_1",
      type: "channel",
      visibility: "public",
    } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall())
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    const eventInsert = spyOn(streamsModule.StreamEventRepository, "insert").mockResolvedValue({ id: "e" } as never)

    await makeService().startCall({ workspaceId: "ws_1", streamId: "stream_1", userId: "usr_a", mode: "video" })

    expect(eventInsert).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: "call_started" })
    )
  })

  it("appends call_ended carrying the end summary for both the completed and reaped paths", async () => {
    stubTransaction()
    const endedAt = new Date(NOW.getTime() + 5000)
    spyOn(CallInvitationRepository, "cancelRingingForCalls").mockResolvedValue([])
    spyOn(CallRepository, "endGraceExpired").mockResolvedValue([
      fakeCall({ id: "call_done", status: "ended", endedReason: "completed", startedAt: NOW, endedAt }),
      fakeCall({ id: "call_reaped", status: "ended", endedReason: "reaped", startedAt: NOW, endedAt }),
    ])
    spyOn(streamsModule.StreamRepository, "findByIds").mockResolvedValue([
      { id: "stream_1", visibility: "private" },
    ] as never)
    const listUserIds = spyOn(CallParticipantRepository, "listUserIdsByCall").mockImplementation(
      async (_c: unknown, _ws: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, ["usr_a", "usr_b"]]))
    )
    const eventInsert = spyOn(streamsModule.StreamEventRepository, "insert").mockResolvedValue({
      id: "evt_ended",
    } as never)

    const result = await makeService().endGraceExpiredCalls(NOW)

    expect(result).toEqual({ ended: 2 })
    expect(eventInsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "call_ended",
        payload: {
          callId: "call_done",
          durationMs: 5000,
          participantUserIds: ["usr_a", "usr_b"],
          endedReason: "completed",
        },
      })
    )
    expect(eventInsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "call_ended",
        payload: expect.objectContaining({ callId: "call_reaped", endedReason: "reaped" }),
      })
    )
    // The participant read is batched over every ended call in one pass (INV-56),
    // not one single-element read per call.
    expect(listUserIds).toHaveBeenCalledTimes(1)
    expect(listUserIds).toHaveBeenCalledWith(expect.anything(), "ws_1", ["call_done", "call_reaped"])
  })

  it("getStreamActiveCall projects the live call with the viewer's own-participant flag", async () => {
    stubWithClient()
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall({ mode: "audio_only" }))
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([
      { userId: "usr_a", endpointId: "callep_1" },
      { userId: "usr_b", endpointId: null },
    ] as never)

    const active = await makeService().getStreamActiveCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
    })

    expect(active).toEqual({
      callId: "call_1",
      mode: "audio_only",
      participantCount: 2,
      participantUserIds: ["usr_a", "usr_b"],
      selfLiveParticipant: true,
    })
  })

  it("getStreamActiveCall returns null when no call is live", async () => {
    stubWithClient()
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(null)
    expect(
      await makeService().getStreamActiveCall({ workspaceId: "ws_1", streamId: "stream_1", userId: "usr_a" })
    ).toBeNull()
  })

  it("listWorkspaceActiveCalls maps active calls to sidebar-dot summaries", async () => {
    spyOn(CallRepository, "listActiveByStreamIds").mockResolvedValue([
      { callId: "call_1", streamId: "stream_1", mode: "video", participantCount: 3 },
    ])
    const calls = await makeService().listWorkspaceActiveCalls({
      workspaceId: "ws_1",
      accessibleStreamIds: ["stream_1"],
    })
    expect(calls).toEqual([
      { callId: "call_1", streamId: "stream_1", rootStreamId: "stream_1", mode: "video", participantCount: 3 },
    ])
  })
})

function fakeCloudflare(overrides: Record<string, unknown> = {}) {
  return {
    createSession: mock(async () => ({ sessionId: "sess_new", sessionDescription: { type: "answer", sdp: "a" } })),
    renegotiateSession: mock(async () => ({})),
    addLocalTracks: mock(async () => ({ requiresImmediateRenegotiation: true, tracks: [] })),
    pullRemoteTracks: mock(async () => ({ requiresImmediateRenegotiation: false, tracks: [] })),
    closeTracks: mock(async () => ({ tracks: [] })),
    closeSession: mock(async () => {}),
    ...overrides,
  }
}

function makeServiceWithCf(cloudflare: Record<string, unknown>) {
  return new CallService({ pool: {} as Pool, cloudflare: cloudflare as never })
}

function stubWithClient() {
  spyOn(dbModule, "withClient").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
}

/** Stub the fence reads (call, endpoint, participant) for a live, owned, incarnation-matched endpoint. */
function stubFence(endpoint: CallEndpoint, call = fakeCall()) {
  spyOn(CallRepository, "findById").mockResolvedValue(call)
  spyOn(CallEndpointRepository, "findById").mockResolvedValue(endpoint)
  spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ id: endpoint.participantId }))
}

describe("CallService.createEndpointCfSession", () => {
  afterEach(() => mock.restore())

  it("is idempotent per incarnation — an endpoint with a CF session returns it without a CF call", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: "sess_existing", mediaIncarnation: "inc_1" }))
    const cf = fakeCloudflare()

    const result = await makeServiceWithCf(cf).createEndpointCfSession({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
    })

    expect(result).toEqual({ cfSessionId: "sess_existing", idempotent: true })
    expect(cf.createSession).not.toHaveBeenCalled()
  })

  it("creates the CF session first, then CAS-binds it onto the endpoint", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: null, mediaIncarnation: "inc_1" }))
    spyOn(CallEndpointRepository, "setCfSessionIfUnset").mockResolvedValue(
      fakeEndpoint({ id: "callep_1", cfSessionId: "sess_new", mediaIncarnation: "inc_1" })
    )
    const cf = fakeCloudflare()

    const result = await makeServiceWithCf(cf).createEndpointCfSession({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
    })

    expect(cf.createSession).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ cfSessionId: "sess_new", idempotent: false })
  })

  it("closes the just-created CF session and 409s when the CAS loses to a stale incarnation", async () => {
    stubWithClient()
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ id: "callp_1" }))
    // First findById is the fence read (live, matching incarnation); the second
    // is the post-CAS re-read, by which point a different incarnation owns the row.
    spyOn(CallEndpointRepository, "findById")
      .mockResolvedValueOnce(
        fakeEndpoint({ id: "callep_1", participantId: "callp_1", cfSessionId: null, mediaIncarnation: "inc_1" })
      )
      .mockResolvedValueOnce(
        fakeEndpoint({ id: "callep_1", participantId: "callp_1", cfSessionId: "sess_other", mediaIncarnation: "inc_2" })
      )
    spyOn(CallEndpointRepository, "setCfSessionIfUnset").mockResolvedValue(null)
    const cf = fakeCloudflare()

    const promise = makeServiceWithCf(cf).createEndpointCfSession({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
    })

    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_STALE_INCARNATION" })
    expect(cf.closeSession).toHaveBeenCalledWith("sess_new")
  })

  it("observes time-to-join on a first-binding endpoint (connection_seq 0)", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: null, mediaIncarnation: "inc_1", connectionSeq: 0 }))
    spyOn(CallEndpointRepository, "setCfSessionIfUnset").mockResolvedValue(
      fakeEndpoint({ id: "callep_1", cfSessionId: "sess_new", mediaIncarnation: "inc_1" })
    )
    const observe = spyOn(observabilityModule.callTimeToJoinSeconds, "observe").mockImplementation(() => {})
    const cf = fakeCloudflare()

    await makeServiceWithCf(cf).createEndpointCfSession({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
    })

    expect(observe).toHaveBeenCalledTimes(1)
  })

  it("does not observe time-to-join when minting a session for a rebound endpoint (connection_seq ≥ 1)", async () => {
    stubWithClient()
    // A reload rebinds the same row (created_at preserved, cf_session_id cleared,
    // connection_seq bumped); observing it would charge the prior connected
    // duration to the histogram.
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: null, mediaIncarnation: "inc_2", connectionSeq: 1 }))
    spyOn(CallEndpointRepository, "setCfSessionIfUnset").mockResolvedValue(
      fakeEndpoint({ id: "callep_1", cfSessionId: "sess_new", mediaIncarnation: "inc_2" })
    )
    const observe = spyOn(observabilityModule.callTimeToJoinSeconds, "observe").mockImplementation(() => {})
    const cf = fakeCloudflare()

    await makeServiceWithCf(cf).createEndpointCfSession({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_2",
    })

    expect(observe).not.toHaveBeenCalled()
  })
})

describe("CallService.setEndpointMediaState", () => {
  afterEach(() => mock.restore())

  it("bumps the roster version and returns the fresh snapshot", async () => {
    stubTransaction()
    stubFence(fakeEndpoint({ id: "callep_1", mediaIncarnation: "inc_1" }))
    const setState = spyOn(CallEndpointRepository, "setMediaState").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(9)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])

    const snapshot = await makeService().setEndpointMediaState({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mediaState: { muted: true },
    })

    expect(snapshot.rosterVersion).toBe(9)
    expect(setState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mediaState: { muted: true } }))
  })

  it("rejects camera-on on an audio-only call", async () => {
    stubTransaction()
    stubFence(fakeEndpoint({ id: "callep_1", mediaIncarnation: "inc_1" }), fakeCall({ mode: "audio_only" }))

    const promise = makeService().setEndpointMediaState({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mediaState: { cameraOn: true },
    })

    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_CAMERA_NOT_ALLOWED" })
  })

  it("locks the call row before the endpoint media-state write (S4) and passes the fenced incarnation (S5)", async () => {
    stubTransaction()
    const order: string[] = []
    const lock = spyOn(CallRepository, "findByIdForUpdate").mockImplementation(async () => {
      order.push("lock")
      return fakeCall()
    })
    stubFence(fakeEndpoint({ id: "callep_1", mediaIncarnation: "inc_1" }))
    const setState = spyOn(CallEndpointRepository, "setMediaState").mockImplementation(async () => {
      order.push("write")
      return fakeEndpoint()
    })
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(2)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])

    await makeService().setEndpointMediaState({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mediaState: { muted: true },
    })

    // Call lock precedes the endpoint write (S4 call→endpoint lock order).
    expect(order).toEqual(["lock", "write"])
    expect(lock).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
    // The write is fenced on the caller's incarnation (S5).
    expect(setState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mediaIncarnation: "inc_1" }))
  })

  it("409s when the media-state write matches nothing — stale incarnation or closed endpoint (S5)", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    stubFence(fakeEndpoint({ id: "callep_1", mediaIncarnation: "inc_1" }))
    spyOn(CallEndpointRepository, "setMediaState").mockResolvedValue(null)
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(2)

    const promise = makeService().setEndpointMediaState({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mediaState: { muted: true },
    })

    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_ENDPOINT_NOT_LIVE" })
    // No roster bump for state that wasn't persisted.
    expect(bump).not.toHaveBeenCalled()
  })
})

describe("CallService.publishTracks", () => {
  afterEach(() => mock.restore())

  it("publishes to CF, sets the registry, and bumps the roster version", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: "sess_1", mediaIncarnation: "inc_1" }))
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(4)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    const cf = fakeCloudflare()

    const result = await makeServiceWithCf(cf).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "mic", mid: "0", trackName: "mic0" }],
    })

    expect(cf.addLocalTracks).toHaveBeenCalledWith("sess_1", {
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ location: "local", trackName: "mic0", mid: "0" }],
    })
    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      // The registry write is fenced on the caller's incarnation (S5).
      expect.objectContaining({ publishedTracks: [{ kind: "mic", trackName: "mic0" }], mediaIncarnation: "inc_1" })
    )
    expect(result.snapshot.rosterVersion).toBe(4)
  })

  it("should keep the mic entry when a camera publish declares only the camera", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(
      fakeEndpoint({
        id: "callep_1",
        cfSessionId: "sess_1",
        mediaIncarnation: "inc_1",
        publishedTracks: [{ kind: "mic", trackName: "mic0" }],
      })
    )
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(5)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])

    await makeServiceWithCf(fakeCloudflare()).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "camera", mid: "1", trackName: "cam1" }],
    })

    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publishedTracks: [
          { kind: "mic", trackName: "mic0" },
          { kind: "camera", trackName: "cam1" },
        ],
      })
    )
  })

  it("should replace the entry when the same kind republishes", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(
      fakeEndpoint({
        id: "callep_1",
        cfSessionId: "sess_1",
        mediaIncarnation: "inc_1",
        publishedTracks: [
          { kind: "mic", trackName: "mic-old" },
          { kind: "camera", trackName: "cam1" },
        ],
      })
    )
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(6)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])

    await makeServiceWithCf(fakeCloudflare()).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "mic", mid: "0", trackName: "mic-new" }],
    })

    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publishedTracks: [
          { kind: "camera", trackName: "cam1" },
          { kind: "mic", trackName: "mic-new" },
        ],
      })
    )
  })

  it("should not carry another incarnation's entries into the write", async () => {
    stubWithClient()
    stubTransaction()
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant({ id: "callp_1" }))
    // The endpoint rebinds between the fence read and the in-tx re-read: the
    // fence sees inc_1, the transaction sees a row re-leased under inc_0 whose
    // registry must not leak into this writer's merge.
    spyOn(CallEndpointRepository, "findById")
      .mockResolvedValueOnce(
        fakeEndpoint({
          id: "callep_1",
          cfSessionId: "sess_1",
          mediaIncarnation: "inc_1",
          publishedTracks: [{ kind: "mic", trackName: "mic0" }],
        })
      )
      .mockResolvedValueOnce(
        fakeEndpoint({
          id: "callep_1",
          cfSessionId: "sess_1",
          mediaIncarnation: "inc_0",
          publishedTracks: [{ kind: "mic", trackName: "stale-mic" }],
        })
      )
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(7)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])

    await makeServiceWithCf(fakeCloudflare()).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "camera", mid: "1", trackName: "cam1" }],
    })

    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishedTracks: [{ kind: "camera", trackName: "cam1" }] })
    )
  })

  it("throws 502 and writes no registry when CF reports a per-track error (S7)", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: "sess_1", mediaIncarnation: "inc_1" }))
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(4)
    const cf = fakeCloudflare({
      addLocalTracks: mock(async () => ({
        requiresImmediateRenegotiation: false,
        tracks: [{ trackName: "mic0", errorCode: "TRACK_REJECTED", errorDescription: "bad mid" }],
      })),
    })

    const promise = makeServiceWithCf(cf).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "mic", mid: "0", trackName: "mic0" }],
    })

    await expect(promise).rejects.toMatchObject({ status: 502, code: "CALL_MEDIA_PROVIDER_ERROR" })
    // A failed track is never written into the registry as pullable, and no roster bump fires.
    expect(setTracks).not.toHaveBeenCalled()
    expect(bump).not.toHaveBeenCalled()
  })

  it("503s when the media plane is unconfigured", async () => {
    const promise = makeService().publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "mic", mid: "0", trackName: "mic0" }],
    })
    await expect(promise).rejects.toMatchObject({ status: 503, code: "CALLS_UNAVAILABLE" })
  })

  it("rejects a camera-kind publish on an audio-only call before any CF call", async () => {
    stubWithClient()
    stubFence(
      fakeEndpoint({ id: "callep_1", cfSessionId: "sess_1", mediaIncarnation: "inc_1" }),
      fakeCall({ mode: "audio_only" })
    )
    const cf = fakeCloudflare()

    const promise = makeServiceWithCf(cf).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "camera", mid: "1", trackName: "cam1" }],
    })

    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_CAMERA_NOT_ALLOWED" })
    expect(cf.addLocalTracks).not.toHaveBeenCalled()
  })

  it("allows a screen-share publish on an audio-only call (huddle semantics)", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(
      fakeEndpoint({ id: "callep_1", cfSessionId: "sess_1", mediaIncarnation: "inc_1" }),
      fakeCall({ mode: "audio_only" })
    )
    spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(5)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    const cf = fakeCloudflare()

    const result = await makeServiceWithCf(cf).publishTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ kind: "share_video", mid: "2", trackName: "share2" }],
    })

    expect(cf.addLocalTracks).toHaveBeenCalledTimes(1)
    expect(result.snapshot.rosterVersion).toBe(5)
  })
})

describe("CallService.closeTracks", () => {
  afterEach(() => mock.restore())

  it("should prune only the unpublished kinds from the registry", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(
      fakeEndpoint({
        id: "callep_1",
        cfSessionId: "sess_1",
        mediaIncarnation: "inc_1",
        publishedTracks: [
          { kind: "mic", trackName: "mic0" },
          { kind: "camera", trackName: "cam1" },
        ],
      })
    )
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(8)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])

    await makeServiceWithCf(fakeCloudflare()).closeTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mids: ["1"],
      unpublishKinds: ["camera"],
    })

    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishedTracks: [{ kind: "mic", trackName: "mic0" }] })
    )
  })

  it("should prune the registry and return the snapshot even when CF's close fails", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(
      fakeEndpoint({
        id: "callep_1",
        cfSessionId: "sess_1",
        mediaIncarnation: "inc_1",
        publishedTracks: [
          { kind: "mic", trackName: "mic0" },
          { kind: "camera", trackName: "cam1" },
        ],
      })
    )
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(8)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    const cf = fakeCloudflare({
      closeTracks: mock(async () => {
        throw new CloudflareRealtimeError("session gone", { status: 502, code: "CF_HTTP_502" })
      }),
    })

    // Peers pull from the registry; a phantom entry for a dead camera makes every
    // peer's pull hang at CF until timeout — the prune must not ride on CF's health.
    const result = await makeServiceWithCf(cf).closeTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mids: ["1"],
      unpublishKinds: ["camera"],
    })

    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishedTracks: [{ kind: "mic", trackName: "mic0" }] })
    )
    expect(result).toMatchObject({ cf: null, snapshot: { rosterVersion: 8, roster: [] } })
  })

  it("should skip CF entirely on a mid-less unpublish (client-side publish failure cleanup)", async () => {
    stubWithClient()
    stubTransaction()
    stubFence(
      fakeEndpoint({
        id: "callep_1",
        cfSessionId: "sess_1",
        mediaIncarnation: "inc_1",
        publishedTracks: [
          { kind: "mic", trackName: "mic0" },
          { kind: "camera", trackName: "cam1" },
        ],
      })
    )
    const setTracks = spyOn(CallEndpointRepository, "setPublishedTracks").mockResolvedValue(fakeEndpoint())
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(9)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    const cf = fakeCloudflare()

    const result = await makeServiceWithCf(cf).closeTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
      mids: [],
      unpublishKinds: ["camera"],
    })

    expect(cf.closeTracks).not.toHaveBeenCalled()
    expect(setTracks).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishedTracks: [{ kind: "mic", trackName: "mic0" }] })
    )
    expect(result.snapshot).toEqual({ rosterVersion: 9, roster: [] })
  })

  it("should still fail loudly when a pull-side close (no unpublishKinds) hits a CF error", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_1", cfSessionId: "sess_1", mediaIncarnation: "inc_1" }))
    const cf = fakeCloudflare({
      closeTracks: mock(async () => {
        throw new CloudflareRealtimeError("session gone", { status: 502, code: "CF_HTTP_502" })
      }),
    })

    await expect(
      makeServiceWithCf(cf).closeTracks({
        workspaceId: "ws_1",
        callId: "call_1",
        userId: "usr_1",
        endpointId: "callep_1",
        mediaIncarnation: "inc_1",
        mids: ["remote-0"],
      })
    ).rejects.toMatchObject({ code: "CALL_MEDIA_PROVIDER_ERROR" })
  })
})

describe("summarizeSdpMSections", () => {
  it("should list mid, kind, and direction per m-section in SDP order", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=sendonly",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:2",
      "a=recvonly",
    ].join("\r\n")
    expect(summarizeSdpMSections(sdp)).toBe("0:audio:sendonly 2:video:recvonly")
    expect(summarizeSdpMSections(undefined)).toBe("none")
  })
})

describe("CallService.joinCall — incarnation rebind", () => {
  afterEach(() => mock.restore())

  it("re-binds a reconnecting endpoint to the same epoch on a reload (new incarnation)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({ id: "callep_old", epoch: 5, status: "reconnecting", mediaIncarnation: "inc_old" })
    )
    // A reload mints a new incarnation, so rebind drops the previous incarnation's
    // dead CF session (cfSessionId null) — createEndpointCfSession then mints fresh
    // instead of short-circuiting on the stale id (INV-41).
    const rebind = spyOn(CallEndpointRepository, "rebind").mockResolvedValue(
      fakeEndpoint({
        id: "callep_old",
        epoch: 5,
        connectionSeq: 6,
        status: "connected",
        mediaIncarnation: "inc_new",
        cfSessionId: null,
      })
    )
    const insert = spyOn(CallEndpointRepository, "insert").mockResolvedValue(fakeEndpoint())
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      mediaIncarnation: "inc_new",
    })

    expect(rebind).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "callep_old", mediaIncarnation: "inc_new" })
    )
    expect(insert).not.toHaveBeenCalled()
    expect(result.endpoint).toMatchObject({ id: "callep_old", epoch: 5, cfSessionId: null })
  })

  it("closes the OLD incarnation's CF session after a reload rebind commit (S3)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({
        id: "callep_old",
        epoch: 5,
        status: "reconnecting",
        mediaIncarnation: "inc_old",
        cfSessionId: "sess_old",
      })
    )
    const insert = spyOn(CallEndpointRepository, "insert").mockResolvedValue(fakeEndpoint())
    spyOn(CallEndpointRepository, "rebind").mockResolvedValue(
      fakeEndpoint({
        id: "callep_old",
        epoch: 5,
        connectionSeq: 6,
        status: "connected",
        mediaIncarnation: "inc_new",
        cfSessionId: null,
      })
    )
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    const closeSession = mock(async () => {})

    await makeServiceWithCf({ closeSession }).joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      mediaIncarnation: "inc_new",
    })

    // Reload drops the previous incarnation's CF session; the OLD id is closed after commit.
    expect(insert).not.toHaveBeenCalled()
    expect(closeSession).toHaveBeenCalledWith("sess_old")
  })

  it("does NOT close the CF session on a same-incarnation transient reconnect (S3)", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "findLiveByParticipant").mockResolvedValue(
      fakeEndpoint({
        id: "callep_old",
        epoch: 5,
        status: "reconnecting",
        mediaIncarnation: "inc_1",
        cfSessionId: "sess_1",
      })
    )
    spyOn(CallEndpointRepository, "rebind").mockResolvedValue(
      fakeEndpoint({
        id: "callep_old",
        epoch: 5,
        status: "connected",
        mediaIncarnation: "inc_1",
        cfSessionId: "sess_1",
      })
    )
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])
    const closeSession = mock(async () => {})

    await makeServiceWithCf({ closeSession }).joinCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      mediaIncarnation: "inc_1",
    })

    // Same incarnation keeps the live CF session — nothing to tear down.
    expect(closeSession).not.toHaveBeenCalled()
  })
})

describe("CallService.markEndpointReconnecting", () => {
  afterEach(() => mock.restore())

  it("locks the call row before the endpoint CAS, then demotes and bumps the roster in the same tx", async () => {
    stubTransaction()
    const order: string[] = []
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint({ id: "callep_1", callId: "call_1" }))
    const lock = spyOn(CallRepository, "findByIdForUpdate").mockImplementation(async () => {
      order.push("lock")
      return fakeCall()
    })
    spyOn(CallEndpointRepository, "markReconnecting").mockImplementation(async () => {
      order.push("cas")
      return fakeEndpoint({ id: "callep_1", status: "reconnecting" })
    })
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(3)

    const result = await makeService().markEndpointReconnecting({
      workspaceId: "ws_1",
      endpointId: "callep_1",
      epoch: 2,
      connectionSeq: 0,
    })

    expect(result?.status).toBe("reconnecting")
    // Call lock precedes the endpoint CAS (S4 call→endpoint lock order).
    expect(order).toEqual(["lock", "cas"])
    expect(lock).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
    // The disconnect broadcast must be newer than what peers hold (INV-66).
    expect(bump).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
  })

  it("skips the bump on a stale fence (a fast reconnect already re-bound the endpoint)", async () => {
    stubTransaction()
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint({ id: "callep_1", callId: "call_1" }))
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "markReconnecting").mockResolvedValue(null)
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(3)

    const result = await makeService().markEndpointReconnecting({
      workspaceId: "ws_1",
      endpointId: "callep_1",
      epoch: 2,
      connectionSeq: 0,
    })

    expect(result).toBeNull()
    expect(bump).not.toHaveBeenCalled()
  })

  it("no-ops (null) when the endpoint no longer exists, without locking a call", async () => {
    stubTransaction()
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(null)
    const lock = spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    const markReconnecting = spyOn(CallEndpointRepository, "markReconnecting").mockResolvedValue(null)

    const result = await makeService().markEndpointReconnecting({
      workspaceId: "ws_1",
      endpointId: "callep_gone",
      epoch: 2,
      connectionSeq: 0,
    })

    expect(result).toBeNull()
    expect(lock).not.toHaveBeenCalled()
    expect(markReconnecting).not.toHaveBeenCalled()
  })
})

describe("CallService.pullTracks — pull authorization (S1)", () => {
  afterEach(() => mock.restore())

  it("passes through a pull of a peer's published track on this call", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_self", cfSessionId: "sess_self", mediaIncarnation: "inc_1" }))
    spyOn(CallEndpointRepository, "listLiveByCall").mockResolvedValue([
      fakeEndpoint({ id: "callep_self", cfSessionId: "sess_self" }),
      fakeEndpoint({
        id: "callep_peer",
        cfSessionId: "sess_peer",
        publishedTracks: [{ kind: "mic", trackName: "mic0" }],
      }),
    ])
    const cf = fakeCloudflare()

    const result = await makeServiceWithCf(cf).pullTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_self",
      mediaIncarnation: "inc_1",
      tracks: [{ location: "remote", sessionId: "sess_peer", trackName: "mic0" }],
    })

    expect(cf.pullRemoteTracks).toHaveBeenCalledWith("sess_self", {
      tracks: [{ location: "remote", sessionId: "sess_peer", trackName: "mic0" }],
    })
    expect(result.cf).toBeDefined()
  })

  it("rejects a ref belonging to another call's session with 403 and makes no CF call", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_self", cfSessionId: "sess_self", mediaIncarnation: "inc_1" }))
    // Only this call's own peer is live; the requested session was learned elsewhere.
    spyOn(CallEndpointRepository, "listLiveByCall").mockResolvedValue([
      fakeEndpoint({ id: "callep_self", cfSessionId: "sess_self" }),
      fakeEndpoint({
        id: "callep_peer",
        cfSessionId: "sess_peer",
        publishedTracks: [{ kind: "mic", trackName: "mic0" }],
      }),
    ])
    const cf = fakeCloudflare()

    const promise = makeServiceWithCf(cf).pullTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_self",
      mediaIncarnation: "inc_1",
      tracks: [{ location: "remote", sessionId: "sess_from_call_b", trackName: "mic0" }],
    })

    await expect(promise).rejects.toMatchObject({ status: 403, code: "CALL_PULL_FORBIDDEN" })
    expect(cf.pullRemoteTracks).not.toHaveBeenCalled()
  })

  it("rejects pulling the caller's own published track (own endpoint excluded from the allowed set)", async () => {
    stubWithClient()
    stubFence(fakeEndpoint({ id: "callep_self", cfSessionId: "sess_self", mediaIncarnation: "inc_1" }))
    spyOn(CallEndpointRepository, "listLiveByCall").mockResolvedValue([
      fakeEndpoint({
        id: "callep_self",
        cfSessionId: "sess_self",
        publishedTracks: [{ kind: "mic", trackName: "self0" }],
      }),
    ])
    const cf = fakeCloudflare()

    const promise = makeServiceWithCf(cf).pullTracks({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_1",
      endpointId: "callep_self",
      mediaIncarnation: "inc_1",
      tracks: [{ location: "remote", sessionId: "sess_self", trackName: "self0" }],
    })

    await expect(promise).rejects.toMatchObject({ status: 403, code: "CALL_PULL_FORBIDDEN" })
    expect(cf.pullRemoteTracks).not.toHaveBeenCalled()
  })
})

describe("CallService.startCall — expectedCallId ring-acceptance guard (S11)", () => {
  afterEach(() => mock.restore())

  it("409 CALL_ENDED when the call it would re-enter differs from expectedCallId", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall({ id: "call_current" }))
    const admit = spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())

    const promise = makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
      mode: "video",
      expectedCallId: "call_expected",
    })

    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_ENDED" })
    // Rejected before any membership admission.
    expect(admit).not.toHaveBeenCalled()
  })

  it("409 CALL_ENDED when a fresh call is created but a specific prior call was expected", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(fakeCall({ id: "call_new" }))
    const admit = spyOn(CallParticipantRepository, "admit").mockResolvedValue(fakeParticipant())

    const promise = makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
      mode: "video",
      expectedCallId: "call_old",
    })

    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_ENDED" })
    expect(admit).not.toHaveBeenCalled()
  })

  it("proceeds when expectedCallId matches the call being re-entered", async () => {
    stubTransaction()
    spyOn(streamsModule, "assertStreamWritable").mockResolvedValue({
      target: { id: "stream_1", type: "channel" },
    } as never)
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)
    spyOn(CallRepository, "insertIfNoActiveCall").mockResolvedValue(null)
    spyOn(CallRepository, "findOpenByStream").mockResolvedValue(fakeCall({ id: "call_expected" }))
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ id: "call_expected" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(1)
    const admit = spyOn(CallParticipantRepository, "admit").mockResolvedValue(
      fakeParticipant({ callId: "call_expected" })
    )
    stubCleanEndpointAdmission()
    spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_a",
      mode: "video",
      expectedCallId: "call_expected",
    })

    expect(result.call.id).toBe("call_expected")
    expect(admit).toHaveBeenCalledTimes(1)
  })
})
