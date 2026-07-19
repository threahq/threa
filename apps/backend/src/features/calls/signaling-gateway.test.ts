import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Server } from "socket.io"
import { registerCallGateway } from "./signaling-gateway"
import { HttpError } from "../../lib/errors"
import * as workspacesModule from "../workspaces"

type Ack = (result: { ok: boolean; error?: string; code?: string; data?: unknown }) => void

function fakeSocket(workosUserId = "workos_1") {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const joined = new Set<string>()
  const left = new Set<string>()
  return {
    data: { workosUserId },
    on(event: string, cb: (...args: unknown[]) => unknown) {
      handlers.set(event, cb)
    },
    join: mock(async (room: string) => {
      joined.add(room)
    }),
    leave: mock(async (room: string) => {
      left.add(room)
    }),
    joined,
    left,
    trigger(event: string, ...args: unknown[]) {
      return handlers.get(event)?.(...args)
    },
  }
}

function setup(overrides?: {
  callService?: Record<string, unknown>
  cloudflareEnabled?: boolean
  callsEnabled?: boolean
  user?: unknown
}) {
  const emit = mock(() => {})
  const to = mock(() => ({ emit }))
  let connectionHandler: ((socket: unknown) => void) | undefined
  const namespace = {
    use: mock(() => {}),
    to,
    on: (event: string, cb: (socket: unknown) => void) => {
      if (event === "connection") connectionHandler = cb
    },
  }
  const io = { of: mock(() => namespace) } as unknown as Server

  spyOn(workspacesModule.UserRepository, "findByWorkosUserIdInWorkspace").mockResolvedValue(
    (overrides?.user === undefined ? { id: "usr_1" } : overrides.user) as never
  )

  const callService = {
    joinCall: mock(async () => ({
      call: { id: "call_1" },
      participant: { id: "callp_1" },
      endpoint: { id: "callep_1", epoch: 2, connectionSeq: 4 },
    })),
    leaveCall: mock(async () => ({ call: { id: "call_1" } })),
    getRosterSnapshot: mock(async () => ({ rosterVersion: 7, roster: [{ userId: "usr_1" }] })),
    setEndpointMediaState: mock(async () => ({
      rosterVersion: 8,
      roster: [{ userId: "usr_1", mediaState: { muted: true } }],
    })),
    renewEndpointLease: mock(async () => ({ leaseExpiresAt: new Date("2026-07-19T12:00:45.000Z") })),
    markEndpointReconnecting: mock(async () => ({ id: "callep_1", status: "reconnecting" })),
    ...overrides?.callService,
  }

  const workspaceSettingsService = {
    getSettings: mock(async () => ({ callsEnabled: overrides?.callsEnabled ?? true })),
  }

  registerCallGateway(io, {
    authService: {} as never,
    callService: callService as never,
    workspaceSettingsService: workspaceSettingsService as never,
    pool: {} as never,
    cloudflareEnabled: overrides?.cloudflareEnabled ?? true,
  })

  const socket = fakeSocket()
  connectionHandler!(socket)

  return { socket, callService, workspaceSettingsService, emit, to, namespace }
}

const JOIN = { workspaceId: "ws_1", callId: "call_1", mediaIncarnation: "inc_1" }

describe("registerCallGateway call:join", () => {
  afterEach(() => mock.restore())

  it("joins the call + endpoint rooms and acks the endpoint id, epoch, versioned roster, and lease ttl", async () => {
    const { socket, callService } = setup()
    const ack = mock(() => {})

    await socket.trigger("call:join", JOIN, ack)

    expect(callService.joinCall).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", callId: "call_1", userId: "usr_1", mediaIncarnation: "inc_1" })
    )
    expect(socket.joined.has("call:call_1")).toBe(true)
    expect(socket.joined.has("call:call_1:ep:callep_1")).toBe(true)
    const arg = (ack as ReturnType<typeof mock>).mock.calls[0][0] as { ok: boolean; data: Record<string, unknown> }
    expect(arg.ok).toBe(true)
    expect(arg.data).toMatchObject({ endpointId: "callep_1", epoch: 2, rosterVersion: 7, leaseTtlMs: 45_000 })
  })

  it("passes takeover through to joinCall", async () => {
    const { socket, callService } = setup()
    await socket.trigger(
      "call:join",
      { ...JOIN, takeover: true },
      mock(() => {})
    )
    expect(callService.joinCall).toHaveBeenCalledWith(expect.objectContaining({ takeover: true }))
  })

  it("acks CALLS_UNAVAILABLE when the media plane is unconfigured", async () => {
    const { socket, callService } = setup({ cloudflareEnabled: false })
    const ack = mock(() => {})
    await socket.trigger("call:join", JOIN, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "CALLS_UNAVAILABLE" }))
    expect(callService.joinCall).not.toHaveBeenCalled()
  })

  it("rejects the join with CALLS_DISABLED when the workspace kill-switch is off", async () => {
    const { socket, callService } = setup({ callsEnabled: false })
    const ack = mock(() => {})
    await socket.trigger("call:join", JOIN, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "CALLS_DISABLED" }))
    expect(callService.joinCall).not.toHaveBeenCalled()
  })

  it("rejects a removed participant with the service's HttpError code", async () => {
    const { socket } = setup({
      callService: {
        joinCall: mock(async () => {
          throw new HttpError("removed", { status: 403, code: "CALL_PARTICIPANT_REMOVED" })
        }),
      },
    })
    const ack = mock(() => {})
    await socket.trigger("call:join", JOIN, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "CALL_PARTICIPANT_REMOVED" }))
  })

  it("rejects an invalid payload", async () => {
    const { socket, callService } = setup()
    const ack = mock(() => {})
    await socket.trigger("call:join", { workspaceId: "ws_1" }, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "VALIDATION_ERROR" }))
    expect(callService.joinCall).not.toHaveBeenCalled()
  })

  it("leaves the prior call's rooms when a bound socket rejoins (no stale fan-in on rebind)", async () => {
    let joinCount = 0
    const { socket } = setup({
      callService: {
        joinCall: mock(async () => {
          joinCount += 1
          return joinCount === 1
            ? {
                call: { id: "call_1" },
                participant: { id: "callp_1" },
                endpoint: { id: "callep_1", epoch: 2, connectionSeq: 4 },
              }
            : {
                call: { id: "call_2" },
                participant: { id: "callp_2" },
                endpoint: { id: "callep_2", epoch: 1, connectionSeq: 1 },
              }
        }),
      },
    })

    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )
    await socket.trigger(
      "call:join",
      { workspaceId: "ws_1", callId: "call_2", mediaIncarnation: "inc_2" },
      mock(() => {})
    )

    // The prior call's rooms are left so its roster fan-out no longer reaches this socket.
    expect(socket.left.has("call:call_1")).toBe(true)
    expect(socket.left.has("call:call_1:ep:callep_1")).toBe(true)
    expect(socket.joined.has("call:call_2")).toBe(true)
    expect(socket.joined.has("call:call_2:ep:callep_2")).toBe(true)
  })
})

describe("registerCallGateway call:state", () => {
  afterEach(() => mock.restore())

  it("bumps the roster version and fans call:roster to the call room", async () => {
    const { socket, callService, to, emit } = setup()
    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )

    const ack = mock(() => {})
    await socket.trigger("call:state", { muted: true }, ack)

    expect(callService.setEndpointMediaState).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: "callep_1", mediaIncarnation: "inc_1", mediaState: { muted: true } })
    )
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { rosterVersion: 8 } }))
    expect(to).toHaveBeenCalledWith("call:call_1")
    expect(emit).toHaveBeenLastCalledWith("call:roster", expect.objectContaining({ rosterVersion: 8 }))
  })

  it("rejects call:state before a join", async () => {
    const { socket } = setup()
    const ack = mock(() => {})
    await socket.trigger("call:state", { muted: true }, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "CALL_NOT_JOINED" }))
  })
})

describe("registerCallGateway call:lease:renew", () => {
  afterEach(() => mock.restore())

  it("renews via the bound endpoint + epoch", async () => {
    const { socket, callService } = setup()
    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )

    const ack = mock(() => {})
    await socket.trigger("call:lease:renew", {}, ack)

    expect(callService.renewEndpointLease).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", endpointId: "callep_1", epoch: 2 })
    )
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })

  it("acks CALL_LEASE_SUPERSEDED when the fenced renew returns null", async () => {
    const { socket } = setup({ callService: { renewEndpointLease: mock(async () => null) } })
    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )

    const ack = mock(() => {})
    await socket.trigger("call:lease:renew", {}, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "CALL_LEASE_SUPERSEDED" }))
  })

  it("rejects the renew with CALLS_DISABLED once the kill-switch is flipped off (drains live calls in one TTL)", async () => {
    const { socket, callService, workspaceSettingsService } = setup()
    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )
    workspaceSettingsService.getSettings.mockResolvedValue({ callsEnabled: false } as never)

    const ack = mock(() => {})
    await socket.trigger("call:lease:renew", {}, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: "CALLS_DISABLED" }))
    expect(callService.renewEndpointLease).not.toHaveBeenCalled()
  })
})

describe("registerCallGateway disconnect", () => {
  afterEach(() => mock.restore())

  it("demotes the endpoint to reconnecting (not closed) fenced on the bound epoch", async () => {
    const { socket, callService } = setup()
    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )

    await socket.trigger("disconnect")
    await Promise.resolve()

    expect(callService.markEndpointReconnecting).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      endpointId: "callep_1",
      epoch: 2,
      connectionSeq: 4,
    })
    expect(callService.leaveCall).not.toHaveBeenCalled()
  })
})

describe("registerCallGateway call:leave", () => {
  afterEach(() => mock.restore())

  it("leaves the rooms and fans the updated roster", async () => {
    const { socket, callService } = setup()
    await socket.trigger(
      "call:join",
      JOIN,
      mock(() => {})
    )

    const ack = mock(() => {})
    await socket.trigger("call:leave", {}, ack)

    expect(callService.leaveCall).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: "callep_1", userId: "usr_1", callId: "call_1" })
    )
    expect(socket.left.has("call:call_1")).toBe(true)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  })
})
