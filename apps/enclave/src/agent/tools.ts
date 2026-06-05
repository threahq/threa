import {
  createReadUrlTool,
  createWebSearchTool,
  createGeneralResearchTool,
  runGeneralResearch,
  type AgentTool,
} from "@threa/agent-runtime/runtime"
import type { AgentRuntimeAI } from "@threa/agent-runtime/runtime"
import { isToolCategoryAllowed, type ToolPrivacyCategory } from "@threa/types"
import type { LanguageModel } from "ai"
import { createEnclaveLoadAttachmentTool, type EnclaveAttachmentStore } from "./attachment-tool"

/**
 * The enclave-safe tool surface for an E2E turn.
 *
 * Only the primitives that call external services DIRECTLY — `web_search`
 * (Tavily) and `read_url` (`fetch` with SSRF guards) — are available inside the
 * enclave; the workspace/GitHub/Linear tools need a backend callback the enclave
 * deliberately cannot make (zero plaintext egress). `general_research` runs the
 * SAME bounded loop the backend persona uses, but driving only that web subset,
 * entirely in-process: no backend round-trip, plaintext never leaves the enclave.
 *
 * Without a Tavily key, `web_search` is omitted (and the researcher runs
 * URL-only) — a degraded but functional surface, not a failure.
 */
export interface EnclaveToolDeps {
  /** The enclave's AI over its single OpenRouter connection (usage accumulates into the turn's total). */
  ai: AgentRuntimeAI
  /** Resolved model handle; opaque to the enclave AI, which keys off `modelString`. */
  model: LanguageModel
  /** Bare model id (no `openrouter:` prefix) the loop forwards as `modelString`. */
  modelString: string
  /** Tavily key for `web_search`; when absent, web search is unavailable. */
  tavilyApiKey?: string
  /** Invocation time, used to ground recency-sensitive web searches. */
  currentTime?: string
  timezone?: string
  /**
   * Per-stream tool-privacy policy from the session assignment. `undefined` = no
   * restriction (full surface). Every tool the enclave builds is in the `web`
   * category, so when `web` is not allowed the enclave runs with no tools at all
   * — a pure model turn that can still reply (`send_message` is never gated).
   */
  allowedCategories?: ToolPrivacyCategory[]
  /**
   * This turn's attachment refs + inline ciphertext, powering `load_attachment`.
   * The tool is NOT behind the privacy gate: the files are the conversation's
   * own content (their refs already ride the messages the model reads), not
   * workspace reads or web egress.
   */
  attachments?: EnclaveAttachmentStore
}

export function buildEnclaveTools(deps: EnclaveToolDeps): AgentTool[] {
  // Conversation-local tools live outside the privacy gate (see `attachments`).
  const localTools: AgentTool[] = deps.attachments ? [createEnclaveLoadAttachmentTool(deps.attachments)] : []

  // The owner's policy may forbid web egress for this scratchpad. The enclave's
  // entire *web* surface (web_search, read_url, general_research) then drops,
  // leaving only the conversation-local tools — honest about the privacy the
  // stream keeps without crippling files the model was already shown.
  if (!isToolCategoryAllowed(deps.allowedCategories, "web")) return localTools

  // The web primitives, built fresh on demand. The top-level loop and the
  // research sub-loop each get their OWN instances (the sub-loop runs the same
  // tool defs under a separate AgentRuntime), so this is a factory, not a shared
  // array — a future stateful tool then keeps per-loop state isolated by design.
  const webTools = (): AgentTool[] => {
    const tools: AgentTool[] = []
    if (deps.tavilyApiKey) {
      tools.push(
        createWebSearchTool({ tavilyApiKey: deps.tavilyApiKey, currentTime: deps.currentTime, timezone: deps.timezone })
      )
    }
    tools.push(createReadUrlTool())
    return tools
  }

  // general_research drives the web subset only (no nested sub-agent, no
  // workspace/integration tools the enclave can't reach). Reuses the shared loop.
  const research = createGeneralResearchTool({
    runGeneralResearch: (query, { signal, onSubstep, deadlineAt }) =>
      runGeneralResearch(
        { ai: deps.ai, model: deps.model, modelString: deps.modelString },
        { query, tools: webTools(), signal, deadlineAt, onSubstep }
      ),
  })

  return [...localTools, ...webTools(), research]
}
