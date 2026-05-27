/**
 * OpenRouter Cost Interceptor
 *
 * Captures cost and token usage from OpenRouter API responses for LangChain calls.
 * Uses AsyncLocalStorage to track costs per-request in a thread-safe manner.
 *
 * The CostTracker class owns its AsyncLocalStorage instance to avoid singleton
 * violations (INV-9). Each AI wrapper instance creates its own CostTracker.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { logger } from "../logger"

export interface CapturedUsage {
  cost: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

interface CostStore {
  cost: number
  tokens: {
    prompt: number
    completion: number
    total: number
  }
}

type FetchFunction = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input
  }

  if (input instanceof URL) {
    return input.href
  }

  return input.url
}

/**
 * CostTracker provides thread-safe cost tracking for OpenRouter API calls.
 *
 * Each instance owns its own AsyncLocalStorage, avoiding singleton violations.
 * Use runWithTracking() to establish a tracking context, then getCapturedUsage()
 * to read accumulated costs (e.g., from a LangChain callback).
 *
 * @example
 * const tracker = new CostTracker()
 * const result = await tracker.runWithTracking(async () => {
 *   return compiledGraph.invoke(input, {
 *     callbacks: [
 *       ...getCostTrackingCallbacks({
 *         getCapturedUsage: () => tracker.getCapturedUsage(),
 *         // ... other params
 *       }),
 *     ],
 *   })
 * })
 */
export class CostTracker {
  private storage = new AsyncLocalStorage<CostStore>()

  /**
   * Create a fetch wrapper that captures OpenRouter cost from responses.
   * Pass this to LangChain's ChatOpenAI configuration.
   */
  createInterceptingFetch(originalFetch: FetchFunction = fetch): FetchFunction {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await originalFetch(input, init)

      // Only process OpenRouter responses
      const url = getRequestUrl(input)
      if (!url.includes("openrouter.ai")) {
        return response
      }

      // Check if we're in a tracking context
      const store = this.storage.getStore()
      if (!store) {
        return response
      }

      try {
        // Clone response to read body without consuming it
        const cloned = response.clone()
        const text = await cloned.text()

        // Handle streaming responses (SSE format)
        if (text.startsWith("data:")) {
          // For streaming, we need to find the final chunk with usage info
          const lines = text.split("\n")
          for (const line of lines.reverse()) {
            if (line.startsWith("data:") && line !== "data: [DONE]") {
              try {
                const data = JSON.parse(line.slice(5).trim())
                if (data.usage) {
                  logger.debug({ usage: data.usage, model: data.model }, "OpenRouter streaming response usage")
                  store.cost += data.usage.cost ?? 0
                  store.tokens.prompt += data.usage.prompt_tokens ?? 0
                  store.tokens.completion += data.usage.completion_tokens ?? 0
                  store.tokens.total += data.usage.total_tokens ?? 0
                  break
                }
              } catch {
                // Not valid JSON, skip
              }
            }
          }
        } else {
          // Non-streaming response
          const body = JSON.parse(text)
          if (body.usage) {
            logger.debug({ usage: body.usage, model: body.model }, "OpenRouter non-streaming response usage")
            store.cost += body.usage.cost ?? 0
            store.tokens.prompt += body.usage.prompt_tokens ?? 0
            store.tokens.completion += body.usage.completion_tokens ?? 0
            store.tokens.total += body.usage.total_tokens ?? 0
          } else {
            logger.debug({ model: body.model }, "OpenRouter response has no usage field")
          }
        }
      } catch (error) {
        logger.warn({ error }, "Failed to extract cost from OpenRouter response")
      }

      return response
    }
  }

  /**
   * Run a function with cost tracking enabled.
   * The tracking context is available to getCapturedUsage() and the intercepting fetch.
   */
  async runWithTracking<T>(fn: () => Promise<T>): Promise<T> {
    const store: CostStore = {
      cost: 0,
      tokens: { prompt: 0, completion: 0, total: 0 },
    }

    return this.storage.run(store, fn)
  }

  /**
   * Get the current accumulated usage, if in a tracking context.
   * Returns zeros if not in a tracking context.
   *
   * This is designed to be passed to CostTrackingCallback via getCapturedUsage.
   */
  getCapturedUsage(): CapturedUsage {
    const store = this.storage.getStore()
    if (!store) {
      return { cost: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    }

    return {
      cost: store.cost,
      promptTokens: store.tokens.prompt,
      completionTokens: store.tokens.completion,
      totalTokens: store.tokens.total,
    }
  }
}
