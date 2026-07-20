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
import * as dbModule from "../../db"
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
    status: "connected",
    leaseExpiresAt: NOW,
    createdAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function stubTransaction() {
  spyOn(dbModule, "withTransaction").mockImplementation(async (_pool: any, fn: any) => fn({} as PoolClient))
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
    const ring = spyOn(CallInvitationRepository, "insertRinging").mockResolvedValue({} as never)

    await makeService().startCall({ workspaceId: "ws_1", streamId: "stream_dm", userId: "usr_a", mode: "audio_only" })

    expect(ring).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ inviteeUserId: "usr_peer", inviterUserId: "usr_a", callId: "call_1" })
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
    const accept = spyOn(CallInvitationRepository, "acceptRingingForUser").mockResolvedValue([])

    const result = await makeService().joinCall({ workspaceId: "ws_1", callId: "call_1", userId: "usr_b" })

    expect(revive).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ inviteeUserId: "usr_b" }))
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

  it("declineInvitation returns the declined ring", async () => {
    stubTransaction()
    spyOn(CallInvitationRepository, "decline").mockResolvedValue({ id: "callinv_1", status: "declined" } as never)

    const result = await makeService().declineInvitation({
      workspaceId: "ws_1",
      invitationId: "callinv_1",
      userId: "usr_peer",
    })

    expect(result).toMatchObject({ status: "declined" })
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

    const result = await makeService().reapLapsedEndpoints(NOW)

    expect(result).toEqual({ endpoints: 2, participants: 1, calls: 1 })
    // Call lock precedes the endpoint close — the fix for the endpoint→call AB-BA deadlock.
    expect(order).toEqual(["lock", "reap"])
    expect(lock).toHaveBeenCalledWith(expect.anything(), ["call_1"])
    expect(markLeft).toHaveBeenCalledWith(expect.anything(), ["callp_a", "callp_b"])
    expect(grace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ callIds: ["call_1"] }))
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

    expect(await makeService().expireStaleRings(NOW)).toEqual({ expired: 1 })
    expect(await makeService().endGraceExpiredCalls(NOW)).toEqual({ ended: 1 })
  })
})
