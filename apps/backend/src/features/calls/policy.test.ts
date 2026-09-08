import { describe, expect, it } from "bun:test"
import { decideCallTransportPolicy } from "./policy"
import type { CallTransportPolicyState } from "./policy-repository"

const now = new Date("2026-09-08T13:00:00.000Z")

function state(overrides: Partial<CallTransportPolicyState> = {}): CallTransportPolicyState {
  return {
    id: "callpolicy_1",
    workspaceId: "ws_1",
    callId: "call_1",
    admittedCount: 6,
    desiredTransport: "p2p",
    eligibilityDeadline: null,
    eligibilityGeneration: 0,
    sourceTransportGeneration: 1,
    explicitHoldTarget: null,
    explicitHoldAdmittedCount: null,
    latestReason: "threshold_below_seven",
    version: 1,
    ...overrides,
  }
}

function decide(previous: CallTransportPolicyState | null, overrides: Record<string, unknown> = {}) {
  return decideCallTransportPolicy(previous, {
    now,
    activeTransport: "p2p",
    sourceTransportGeneration: 1,
    admittedCount: 6,
    callsP2pEnabled: true,
    turnConfigured: true,
    allCoordinatorCapable: true,
    allP2pCapable: true,
    callActive: true,
    transferTarget: null,
    ...overrides,
  })
}

describe("decideCallTransportPolicy", () => {
  it("should request one SFU transition at seven and preserve it at eight", () => {
    expect(decide(state(), { admittedCount: 7 }).request).toEqual({
      target: "sfu",
      cause: "automatic_threshold",
    })
    expect(decide(state({ admittedCount: 7 }), { admittedCount: 8, transferTarget: "sfu" })).toMatchObject({
      request: null,
      state: { admittedCount: 8, desiredTransport: "sfu", latestReason: "transfer_active" },
    })
  })

  it("should preserve the exact below-seven deadline and fire at its boundary", () => {
    const armed = decide(null, { activeTransport: "sfu" })
    expect(armed.state.eligibilityDeadline).toEqual(new Date(now.getTime() + 30_000))
    const persisted = state({ ...armed.state, version: 2 })
    expect(decide(persisted, { activeTransport: "sfu", now: new Date(now.getTime() + 29_999) })).toMatchObject({
      request: null,
      state: { eligibilityDeadline: armed.state.eligibilityDeadline, eligibilityGeneration: 1 },
    })
    expect(decide(persisted, { activeTransport: "sfu", now: new Date(now.getTime() + 30_000) }).request).toEqual({
      target: "p2p",
      cause: "automatic_threshold",
    })
  })

  it("should clear a deadline when count returns to seven", () => {
    const previous = state({
      admittedCount: 6,
      desiredTransport: "p2p",
      eligibilityDeadline: new Date(now.getTime() + 30_000),
      eligibilityGeneration: 4,
    })
    expect(decide(previous, { activeTransport: "sfu", admittedCount: 7 }).state).toMatchObject({
      eligibilityDeadline: null,
      eligibilityGeneration: 0,
      desiredTransport: "sfu",
    })
  })

  it("should hold an explicit choice only while admitted count is unchanged", () => {
    const held = state({ explicitHoldTarget: "sfu", explicitHoldAdmittedCount: 6 })
    expect(decide(held).state.latestReason).toBe("explicit_hold")
    expect(decide(held, { admittedCount: 5 }).state).toMatchObject({
      explicitHoldTarget: null,
      explicitHoldAdmittedCount: null,
      latestReason: "threshold_below_seven",
    })
  })

  it("should require P2P and coordinator capability only when selecting P2P", () => {
    const combinations = [
      { allCoordinatorCapable: false, allP2pCapable: false, eligible: false },
      { allCoordinatorCapable: false, allP2pCapable: true, eligible: false },
      { allCoordinatorCapable: true, allP2pCapable: false, eligible: false },
      { allCoordinatorCapable: true, allP2pCapable: true, eligible: true },
    ]
    expect(
      combinations.map(({ eligible, ...capabilities }) => ({
        ...capabilities,
        request: decide(null, { activeTransport: "sfu", ...capabilities }).request,
        deadline: decide(null, { activeTransport: "sfu", ...capabilities }).state.eligibilityDeadline,
        eligible,
      }))
    ).toEqual(
      combinations.map(({ eligible, ...capabilities }) => ({
        ...capabilities,
        request: null,
        deadline: eligible ? new Date(now.getTime() + 30_000) : null,
        eligible,
      }))
    )
  })

  it("should require only coordinator capability to leave P2P", () => {
    expect(decide(null, { callsP2pEnabled: false, allCoordinatorCapable: true, allP2pCapable: false }).request).toEqual(
      { target: "sfu", cause: "rollout_safety" }
    )
    expect(
      decide(null, { callsP2pEnabled: false, allCoordinatorCapable: false, allP2pCapable: true }).request
    ).toBeNull()
  })

  it("should report flag, TURN, and endpoint capability safety reasons distinctly", () => {
    expect(decide(null, { callsP2pEnabled: false }).state.latestReason).toBe("rollout_flag_off")
    expect(decide(null, { turnConfigured: false }).state.latestReason).toBe("rollout_turn_unavailable")
    expect(decide(null, { allP2pCapable: false }).state.latestReason).toBe("rollout_capability_missing")
  })

  it("should let rollout safety override a P2P hold without breaking legacy incumbents", () => {
    const held = state({ explicitHoldTarget: "p2p", explicitHoldAdmittedCount: 6 })
    expect(decide(held, { callsP2pEnabled: false })).toMatchObject({
      request: { target: "sfu", cause: "rollout_safety" },
      state: { explicitHoldTarget: null, latestReason: "rollout_flag_off" },
    })
    expect(decide(held, { callsP2pEnabled: false, turnConfigured: true, allCoordinatorCapable: false })).toMatchObject({
      request: null,
      state: { desiredTransport: "sfu" },
    })
  })
})
