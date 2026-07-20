import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Querier } from "../../db"
import { checkCallAccess } from "./access"
import { CallRepository, type Call } from "./repository"
import * as streamsModule from "../streams"

const NOW = new Date("2026-07-19T12:00:00.000Z")
const DB = {} as Querier

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

describe("checkCallAccess", () => {
  afterEach(() => mock.restore())

  it("returns null for a missing or cross-workspace call (workspace-scoped read)", async () => {
    spyOn(CallRepository, "findById").mockResolvedValue(null)
    const streamAccess = spyOn(streamsModule, "checkStreamAccess")

    const result = await checkCallAccess(DB, { workspaceId: "ws_other", userId: "usr_a", callId: "call_1" })

    expect(result).toBeNull()
    expect(streamAccess).not.toHaveBeenCalled()
  })

  it("requires host-stream access via the canonical predicate", async () => {
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    const streamAccess = spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(null)

    const result = await checkCallAccess(DB, { workspaceId: "ws_1", userId: "usr_a", callId: "call_1" })

    expect(result).toBeNull()
    expect(streamAccess).toHaveBeenCalledWith(DB, "stream_1", "ws_1", "usr_a")
  })

  it("returns the call (never the stream row) when host-stream access is granted", async () => {
    spyOn(CallRepository, "findById").mockResolvedValue(fakeCall())
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1", type: "channel" } as never)

    const result = await checkCallAccess(DB, { workspaceId: "ws_1", userId: "usr_a", callId: "call_1" })

    expect(result).toEqual({ call: fakeCall() })
  })
})
