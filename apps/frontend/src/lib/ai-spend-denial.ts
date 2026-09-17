import type { AISpendDenialReason } from "@threahq/types"

export const SPEND_DENIAL_COPY: Record<AISpendDenialReason, string> = {
  workspace_limit: "Workspace AI limit reached",
  user_limit: "Personal AI limit reached",
  user_agent_allowance: "Agent allowance used up",
  workspace_disabled: "AI turned off by an admin",
  user_disabled: "Your AI access is turned off",
  operator_disabled: "AI turned off by Threa",
}
