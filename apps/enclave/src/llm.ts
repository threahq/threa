import type { EnclaveConfig } from "./config"
import type { OpenAiMessage, OpenAiTool } from "./agent/openai-format"

/**
 * The enclave's LLM transport.
 *
 * Deliberately NOT the backend's `createAI` wrapper (INV-28): that wrapper pulls
 * Langfuse/OTEL telemetry, and the whole point of the enclave is isolation —
 * decrypted prompts and replies must never leave this process except to the LLM
 * provider. A raw, dependency-free OpenRouter chat-completions client keeps the
 * egress surface to exactly one host and emits no telemetry carrying message
 * content. This is the one place in the codebase that calls a model without
 * `createAI`, by design. The agent loop drives this via a thin `AgentRuntimeAI`
 * adapter (see `agent/enclave-ai.ts`).
 */

export interface RawChatRequest {
  model: string
  messages: OpenAiMessage[]
  tools?: OpenAiTool[]
  temperature?: number
  maxTokens?: number
}

export interface RawChatResult {
  /** The assistant turn: free text and/or tool calls. */
  message: {
    content: string | null
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
  }
  model: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** Injectable so the agent loop can be tested without network access. */
export type RawChatFn = (req: RawChatRequest) => Promise<RawChatResult>

/**
 * Upper bound on a single OpenRouter call. Kept under the backend forwarder's
 * timeout so the enclave aborts (and the request fails cleanly) before the
 * backend gives up, rather than leaving a hung connection.
 */
const OPENROUTER_TIMEOUT_MS = 100_000

interface OpenRouterResponse {
  model?: string
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * OpenRouter chat-completions client restricted to zero-retention providers via
 * `provider.data_collection: "deny"` — OpenRouter only routes to upstreams that
 * don't persist request data. The enclave never sets a data-retaining fallback.
 */
export function createOpenRouterChat(config: EnclaveConfig): RawChatFn {
  return async (req) => {
    const res = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openRouterApiKey}`,
        // Attribution only — no message content.
        "X-Title": "Threa Enclave",
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools, tool_choice: "auto" } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        // Restrict routing to providers that do not retain request data.
        provider: { data_collection: "deny" },
      }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    })

    if (!res.ok) {
      // Surface status only — an error body could echo prompt content.
      throw new Error(`OpenRouter request failed: ${res.status}`)
    }

    const data = (await res.json()) as OpenRouterResponse
    const choice = data.choices?.[0]?.message
    if (!choice) {
      throw new Error("OpenRouter returned no message")
    }

    const toolCalls = (choice.tool_calls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({
        id: tc.id ?? "",
        type: "function" as const,
        function: { name: tc.function!.name!, arguments: tc.function!.arguments ?? "{}" },
      }))

    return {
      message: { content: choice.content ?? null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      model: data.model ?? req.model,
      usage: { prompt_tokens: data.usage?.prompt_tokens, completion_tokens: data.usage?.completion_tokens },
    }
  }
}
