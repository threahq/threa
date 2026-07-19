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
import { OutboxRepository } from "../../lib/outbox"
import { CALL_PRODUCT_CAP } from "./config"

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
    expect(admit).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
  })

  it("the loser re-reads the winning call and is still admitted (created=false)", async () => {
    stubTransaction()
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

    const result = await makeService().startCall({
      workspaceId: "ws_1",
      streamId: "stream_1",
      userId: "usr_b",
      mode: "video",
    })

    expect(result).toMatchObject({ created: false, call: { id: "call_winner" } })
    expect(findOpen).toHaveBeenCalledTimes(1)
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it("start into an empty_grace call revives it (no wedge, same locked join path)", async () => {
    stubTransaction()
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
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(null)

    await expect(
      makeService().startCall({ workspaceId: "ws_1", streamId: "stream_x", userId: "usr_a", mode: "video" })
    ).rejects.toMatchObject({ code: "CALL_STREAM_ACCESS_DENIED", status: 403 })
  })
})

describe("CallService.joinCall — revive, capacity, membership", () => {
  afterEach(() => mock.restore())

  it("revives an empty_grace call and accepts a ringing invitation on join", async () => {
    stubTransaction()
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
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall() })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(CALL_PRODUCT_CAP)

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_51" })
    ).rejects.toMatchObject({ code: "CALL_FULL", status: 409 })
  })

  it("rejects a removed participant's self-rejoin", async () => {
    stubTransaction()
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
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: fakeCall({ status: "ended" }) })
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall({ status: "ended" }))

    await expect(
      makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_b" })
    ).rejects.toMatchObject({ code: "CALL_ENDED", status: 409 })
  })

  it("rejects a join with no call access", async () => {
    stubTransaction()
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
})

describe("CallService.leaveCall", () => {
  afterEach(() => mock.restore())

  it("closes the endpoint, lefts the participant, and graces an emptied call", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    const close = spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    const markLeft = spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(
      fakeParticipant({ status: "left" })
    )
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ status: "empty_grace" }))

    const result = await makeService().leaveCall({
      workspaceId: "ws_1",
      callId: "call_1",
      userId: "usr_a",
      endpointId: "callep_1",
    })

    expect(close).toHaveBeenCalledWith(expect.anything(), "ws_1", "callep_1")
    expect(markLeft).toHaveBeenCalledTimes(1)
    expect(grace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "completed" }))
    // A leave bumps the roster version in the same tx (INV-66) so the departed tile isn't a ghost.
    expect(bump).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
    expect(result.call.status).toBe("empty_grace")
  })

  it("does not grace a call that still has joined participants", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallEndpointRepository, "findById").mockResolvedValue(fakeEndpoint())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    spyOn(CallEndpointRepository, "close").mockResolvedValue(fakeEndpoint({ status: "closed" }))
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(2)
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(null)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())

    await makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })

    expect(grace).not.toHaveBeenCalled()
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
    spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ status: "empty_grace" }))
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
    const grace = spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(null)
    const cancelByInviter = spyOn(CallInvitationRepository, "cancelRingingByInviter").mockResolvedValue([
      { id: "callinv_2", workspaceId: "ws_1", callId: "call_1", inviteeUserId: "usr_peer", inviterUserId: "usr_a" },
    ] as never)
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().leaveCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a", endpointId: "callep_1" })

    // The call lives on (others remain) — only the leaver's own ring is retracted.
    expect(grace).not.toHaveBeenCalled()
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

  it("closes the user's endpoints and emits participants_changed on a live call", async () => {
    stubTransaction()
    spyOn(CallRepository, "findByIdForUpdate").mockResolvedValue(fakeCall())
    spyOn(CallParticipantRepository, "findByUser").mockResolvedValue(fakeParticipant())
    const closeByParticipant = spyOn(CallEndpointRepository, "closeByParticipant").mockResolvedValue([])
    spyOn(CallParticipantRepository, "markLeftIfNoLiveEndpoint").mockResolvedValue(fakeParticipant({ status: "left" }))
    spyOn(CallParticipantRepository, "countJoined").mockResolvedValue(0)
    spyOn(CallRepository, "enterGraceIfEmpty").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    spyOn(CallInvitationRepository, "cancelRingingForCall").mockResolvedValue([])
    spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(1)
    spyOn(CallParticipantRepository, "listRoster").mockResolvedValue([])
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall({ status: "empty_grace" }))
    const emit = spyOn(OutboxRepository, "insert").mockResolvedValue({} as never)

    await makeService().leaveCallAsUser({ workspaceId: "ws_1", callId: "call_1", userId: "usr_a" })

    expect(closeByParticipant).toHaveBeenCalledWith(expect.anything(), "ws_1", "callp_1")
    expect(emit).toHaveBeenCalledWith(
      expect.anything(),
      "call:participants_changed",
      expect.objectContaining({ callId: "call_1" })
    )
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
    const bumpBatch = spyOn(CallRepository, "bumpRosterVersionBatch").mockResolvedValue(undefined)

    const result = await makeService().reapLapsedEndpoints(NOW)

    expect(result).toEqual({ endpoints: 2, participants: 1, calls: 1 })
    // Call lock precedes the endpoint close — the fix for the endpoint→call AB-BA deadlock.
    expect(order).toEqual(["lock", "reap"])
    expect(lock).toHaveBeenCalledWith(expect.anything(), ["call_1"])
    expect(markLeft).toHaveBeenCalledWith(expect.anything(), ["callp_a", "callp_b"])
    expect(grace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callIds: ["call_1"] }))
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
      expect.objectContaining({ publishedTracks: [{ kind: "mic", trackName: "mic0" }] })
    )
    expect(result.snapshot.rosterVersion).toBe(4)
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
})

describe("CallService.joinCall — incarnation rebind", () => {
  afterEach(() => mock.restore())

  it("re-binds a reconnecting endpoint to the same epoch on a reload (new incarnation)", async () => {
    stubTransaction()
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
})

describe("CallService.markEndpointReconnecting", () => {
  afterEach(() => mock.restore())

  it("demotes and bumps the roster version in the same tx", async () => {
    stubTransaction()
    spyOn(CallEndpointRepository, "markReconnecting").mockResolvedValue(
      fakeEndpoint({ id: "callep_1", status: "reconnecting" })
    )
    const bump = spyOn(CallRepository, "bumpRosterVersion").mockResolvedValue(3)

    const result = await makeService().markEndpointReconnecting({
      workspaceId: "ws_1",
      endpointId: "callep_1",
      epoch: 2,
      connectionSeq: 0,
    })

    expect(result?.status).toBe("reconnecting")
    // The disconnect broadcast must be newer than what peers hold (INV-66).
    expect(bump).toHaveBeenCalledWith(expect.anything(), "ws_1", "call_1")
  })

  it("skips the bump on a stale fence (a fast reconnect already re-bound the endpoint)", async () => {
    stubTransaction()
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
})
