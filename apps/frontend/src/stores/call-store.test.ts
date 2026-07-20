import { describe, it, expect, beforeEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  getCallState,
  setCallSession,
  setCallPhase,
  setCallRoster,
  setCallSurfaceMode,
  registerCallHangup,
  resetCallStoreCache,
  clearCallState,
} from "./call-store"

const ACCOUNT_SCOPE = resolve(dirname(fileURLToPath(import.meta.url)), "../auth/account-scope.tsx")

describe("call-store", () => {
  beforeEach(() => clearCallState())

  it("starts idle", () => {
    expect(getCallState().phase).toBe("idle")
    expect(getCallState().callId).toBeNull()
  })

  it("tracks session + roster", () => {
    setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    setCallRoster(
      [
        {
          userId: "usr_1",
          participantStatus: "joined",
          endpointId: "ep_1",
          connectionStatus: "connected",
          mediaState: {},
          publishedTracks: [],
        },
      ],
      3
    )
    const state = getCallState()
    expect(state.phase).toBe("joining")
    expect(state.callId).toBe("call_1")
    expect(state.rosterVersion).toBe(3)
    expect(state.roster).toHaveLength(1)
  })

  it("reset performs the ordered hangup BEFORE dropping state", () => {
    const order: string[] = []
    setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const unregister = registerCallHangup(() => {
      // The hangup runs while state is still live (call not yet cleared).
      order.push(`hangup:${getCallState().callId ?? "cleared"}`)
    })

    resetCallStoreCache()

    expect(order).toEqual(["hangup:call_1"])
    expect(getCallState().phase).toBe("idle")
    expect(getCallState().callId).toBeNull()
    unregister()
  })

  it("registration guard: account-scope flushes the call store cache", () => {
    // The flush list is hand-maintained; assert the registration exists so a
    // future edit can't silently drop it (leaving a prior account's mic hot).
    const source = readFileSync(ACCOUNT_SCOPE, "utf8")
    expect(source).toContain("resetCallStoreCache")
    // And that it's actually invoked inside flushModuleStoreCaches, not just imported.
    const flushBody = source.slice(source.indexOf("function flushModuleStoreCaches"))
    expect(flushBody).toContain("resetCallStoreCache()")
  })

  it("surfaceMode: defaults to min, sets, and resets to min on teardown", () => {
    expect(getCallState().surfaceMode).toBe("min")

    setCallSurfaceMode("full")
    expect(getCallState().surfaceMode).toBe("full")

    resetCallStoreCache()
    expect(getCallState().surfaceMode).toBe("min")
  })

  it("connectedAt: stamped once on connect, preserved across reconnects, cleared on teardown", () => {
    setCallSession({ callId: "call_1", workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    expect(getCallState().connectedAt).toBeNull()

    setCallPhase("connected")
    const stamped = getCallState().connectedAt
    expect(typeof stamped).toBe("number")

    // A reconnect blip must not reset the clock.
    setCallPhase("reconnecting")
    setCallPhase("connected")
    expect(getCallState().connectedAt).toBe(stamped)

    resetCallStoreCache()
    expect(getCallState().connectedAt).toBeNull()
  })

  it("unregistering the hangup makes reset a plain state drop", () => {
    const hangup = vi.fn()
    const unregister = registerCallHangup(hangup)
    unregister()
    resetCallStoreCache()
    expect(hangup).not.toHaveBeenCalled()
  })
})
