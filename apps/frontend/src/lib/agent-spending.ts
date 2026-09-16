import type { AgentSessionSpendingStop } from "@threahq/types"

export function spendingStopDescription(stop: AgentSessionSpendingStop): string {
  if (stop.reason === "spending_outcome_unknown") {
    return "The AI request may have completed. It won't be sent again automatically."
  }
  if (stop.reason === "spending_result_unavailable") {
    return "The AI response couldn't be used. This run won't retry automatically."
  }
  if (stop.reason === "spending_replay_blocked") {
    return "This request was already attempted. It won't be sent again automatically."
  }
  switch (stop.code) {
    case "LIMIT_EXCEEDED":
      return "An AI spending limit was reached. Start a new request once spending is available again."
    case "DISABLED":
      return "AI is disabled for this workspace."
    case "EMERGENCY":
      return "AI has been stopped for this workspace. An operator needs to review it."
    case "UNKNOWN_ROUTE":
    case "UNSUPPORTED_OPERATION":
    case "REQUEST_NOT_BOUNDED":
      return "This model or configuration isn't supported by the workspace's spending controls."
    default:
      return "AI spending could not be authorized. This run won't restart automatically."
  }
}
