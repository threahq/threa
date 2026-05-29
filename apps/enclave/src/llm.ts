import type { EnclaveConfig } from "./config"

/**
 * The enclave's LLM client.
 *
 * Deliberately NOT the backend's `createAI` wrapper (INV-28): that wrapper pulls
 * Langfuse/OTEL telemetry, and the whole point of the enclave is isolation —
 * decrypted prompts and replies must never leave this process except to the LLM
 * provider. A raw, dependency-free OpenRouter client keeps the egress surface to
 * exactly one host and emits no telemetry carrying message content. This is the
 * one place in the codebase that calls a model without `createAI`, by design.
 */

export type ChatRole = "system" | "user" | "assistant"

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatCompletionRequest {
  /** OpenRouter model id, e.g. `anthropic/claude-sonnet-4.6`. */
  model: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
}

export interface ChatCompletionResult {
  text: string
  model: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

/** Injectable so the invoke handler can be tested without network access. */
export type ChatCompletionFn = (req: ChatCompletionRequest) => Promise<ChatCompletionResult>

interface OpenRouterResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * OpenRouter chat-completions client restricted to zero-retention providers via
 * `provider.data_collection: "deny"` — OpenRouter only routes to upstreams that
 * don't persist request data. The enclave never sets a data-retaining fallback.
 */
export function createOpenRouterClient(config: EnclaveConfig): ChatCompletionFn {
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
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        // Restrict routing to providers that do not retain request data.
        provider: { data_collection: "deny" },
      }),
    })

    if (!res.ok) {
      // Surface status only — an error body could echo prompt content.
      throw new Error(`OpenRouter request failed: ${res.status}`)
    }

    const data = (await res.json()) as OpenRouterResponse
    const text = data.choices?.[0]?.message?.content
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("OpenRouter returned an empty completion")
    }

    return {
      text,
      model: data.model ?? req.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      },
    }
  }
}
