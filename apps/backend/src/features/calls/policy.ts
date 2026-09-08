import type { CallMediaTransport, CallTransportPolicyReason } from "@threahq/types"
import { CALL_P2P_THRESHOLD, CALL_TRANSPORT_DOWNSHIFT_MS } from "./config"
import type { CallTransportPolicyState } from "./policy-repository"

export interface CallTransportPolicyInput {
  now: Date
  activeTransport: CallMediaTransport
  sourceTransportGeneration: number
  admittedCount: number
  callsP2pEnabled: boolean
  turnConfigured: boolean
  allCoordinatorCapable: boolean
  allP2pCapable: boolean
  callActive: boolean
  transferTarget: CallMediaTransport | null
}

export interface CallTransportPolicyDecision {
  state: Omit<CallTransportPolicyState, "id" | "workspaceId" | "callId" | "version">
  request: { target: CallMediaTransport; cause: "automatic_threshold" | "rollout_safety" } | null
}

export function decideCallTransportPolicy(
  previous: CallTransportPolicyState | null,
  input: CallTransportPolicyInput
): CallTransportPolicyDecision {
  const countChanged = previous !== null && previous.admittedCount !== input.admittedCount
  let holdTarget = countChanged ? null : (previous?.explicitHoldTarget ?? null)
  let holdCount = countChanged ? null : (previous?.explicitHoldAdmittedCount ?? null)
  let deadline = previous?.eligibilityDeadline ?? null
  let deadlineGeneration = previous?.eligibilityGeneration ?? 0
  let desired: CallMediaTransport = input.activeTransport
  let reason: CallTransportPolicyReason = "threshold_below_seven"
  let request: CallTransportPolicyDecision["request"] = null

  if (!input.callActive || input.admittedCount === 0) {
    holdTarget = null
    holdCount = null
    deadline = null
    deadlineGeneration = 0
    reason = "call_empty_or_ended"
  } else if (!input.callsP2pEnabled || !input.turnConfigured || !input.allCoordinatorCapable || !input.allP2pCapable) {
    desired = "sfu"
    deadline = null
    deadlineGeneration = 0
    if (holdTarget === "p2p") {
      holdTarget = null
      holdCount = null
    }
    if (!input.callsP2pEnabled) reason = "rollout_flag_off"
    else if (!input.turnConfigured) reason = "rollout_turn_unavailable"
    else reason = "rollout_capability_missing"
    if (input.activeTransport === "p2p" && input.allCoordinatorCapable && input.transferTarget === null) {
      request = { target: "sfu", cause: "rollout_safety" }
    }
  } else if (holdTarget && holdCount === input.admittedCount) {
    desired = holdTarget
    deadline = null
    deadlineGeneration = 0
    reason = "explicit_hold"
  } else if (input.admittedCount > CALL_P2P_THRESHOLD) {
    desired = "sfu"
    deadline = null
    deadlineGeneration = 0
    reason = "threshold_at_or_above_seven"
    if (input.activeTransport === "p2p" && input.transferTarget === null) {
      request = { target: "sfu", cause: "automatic_threshold" }
    }
  } else if (input.activeTransport === "p2p") {
    desired = "p2p"
    deadline = null
    deadlineGeneration = 0
    reason = "threshold_below_seven"
  } else {
    desired = "p2p"
    reason = "below_seven_deadline"
    if (!deadline || previous?.sourceTransportGeneration !== input.sourceTransportGeneration) {
      deadline = new Date(input.now.getTime() + CALL_TRANSPORT_DOWNSHIFT_MS)
      deadlineGeneration = (previous?.eligibilityGeneration ?? 0) + 1
    } else if (deadline.getTime() <= input.now.getTime() && input.transferTarget === null) {
      request = { target: "p2p", cause: "automatic_threshold" }
    }
  }

  if (input.transferTarget !== null) {
    request = null
    reason = "transfer_active"
  }

  return {
    state: {
      admittedCount: input.admittedCount,
      desiredTransport: desired,
      eligibilityDeadline: deadline,
      eligibilityGeneration: deadlineGeneration,
      sourceTransportGeneration: input.sourceTransportGeneration,
      explicitHoldTarget: holdTarget,
      explicitHoldAdmittedCount: holdCount,
      latestReason: reason,
    },
    request,
  }
}
