import {
  createReadUrlTool,
  createWebSearchTool,
  createGeneralResearchTool,
  runGeneralResearch,
  type AgentTool,
} from "@threa/agent-runtime/runtime"
import type { AgentRuntimeAI } from "@threa/agent-runtime/runtime"
import type { LanguageModel } from "ai"

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
}

export function buildEnclaveTools(deps: EnclaveToolDeps): AgentTool[] {
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
        {
          query,
          tools: webTools(),
          signal,
          deadlineAt,
          onSubstep,
        }
      ),
  })

  return [...webTools(), research]
}
