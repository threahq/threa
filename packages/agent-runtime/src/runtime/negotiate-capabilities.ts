import { areToolCategoriesAllowed, type ToolPrivacyCategory } from "@threa/types"
import type { AgentTool } from "./agent-tool"

/**
 * The single chokepoint where a stream's tool-privacy policy meets a built
 * toolset (agent-runtimes unification §2.2.3). Phase 1.4 scope: fold the
 * per-stream `allowed_tool_categories` policy over the tools, filtering on each
 * tool's OWN declared `config.categories` — so one function gates the companion
 * (in-process) and the enclave (in-enclave) identically, and the system prompt
 * follows automatically because tool prose derives from the surviving toolset
 * (`buildToolPromptSections`). Later phases grow this into the full
 * `CapabilityManifest` negotiation (trust tiers, sealed-delivery rule).
 */
export interface NegotiateCapabilitiesParams {
  /**
   * Per-stream tool-privacy policy: the allowed categories. `null`/`undefined`
   * means "no restriction" (the default — streams without a policy row).
   * `messaging` and conversation-local tools (empty `categories`) always pass.
   */
  streamPolicy: ToolPrivacyCategory[] | null | undefined
  tools: AgentTool[]
}

export interface NegotiatedCapabilities {
  tools: AgentTool[]
}

export function negotiateCapabilities({ streamPolicy, tools }: NegotiateCapabilitiesParams): NegotiatedCapabilities {
  return {
    tools: tools.filter((tool) => areToolCategoriesAllowed(streamPolicy, tool.config.categories)),
  }
}
