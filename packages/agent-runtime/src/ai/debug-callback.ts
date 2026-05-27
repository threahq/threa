/**
 * Debug Callback for LangChain/LangGraph
 *
 * Logs timing information for LLM calls, tool executions, and chain steps.
 * Enabled via LANGGRAPH_DEBUG=true environment variable.
 *
 * Usage:
 * ```typescript
 * const result = await compiledGraph.invoke(input, {
 *   callbacks: [
 *     ...getLangfuseCallbacks({ ... }),
 *     ...getDebugCallbacks(),
 *   ],
 * })
 * ```
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { LLMResult } from "@langchain/core/outputs"
import type { ChainValues } from "@langchain/core/utils/types"
import type { Serialized } from "@langchain/core/load/serializable"
import { logger } from "../logger"

// Track start times for duration calculation
const startTimes = new Map<string, number>()

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/**
 * Check if debug logging is enabled.
 */
export function isDebugEnabled(): boolean {
  return process.env.LANGGRAPH_DEBUG === "true"
}

/**
 * LangChain callback handler that logs timing for all operations.
 */
export class DebugCallback extends BaseCallbackHandler {
  name = "debug-timing"

  // LLM Events
  async handleLLMStart(llm: Serialized, prompts: string[], runId: string): Promise<void> {
    startTimes.set(`llm:${runId}`, Date.now())
    const model = llm.id?.[llm.id.length - 1] ?? "unknown"
    const promptPreview = prompts[0]?.slice(0, 100) ?? ""
    logger.info({ runId, model, promptLength: prompts[0]?.length, promptPreview }, `[LLM START] ${model}`)
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const startTime = startTimes.get(`llm:${runId}`)
    const duration = startTime ? Date.now() - startTime : 0
    startTimes.delete(`llm:${runId}`)

    const model = (output.llmOutput?.model as string) ?? "unknown"
    const tokenUsage = output.llmOutput?.tokenUsage as
      | { promptTokens?: number; completionTokens?: number; totalTokens?: number }
      | undefined
    const responsePreview = output.generations?.[0]?.[0]?.text?.slice(0, 100) ?? ""

    logger.info(
      {
        runId,
        model,
        duration,
        durationFormatted: formatDuration(duration),
        promptTokens: tokenUsage?.promptTokens,
        completionTokens: tokenUsage?.completionTokens,
        totalTokens: tokenUsage?.totalTokens,
        responsePreview,
      },
      `[LLM END] ${model} - ${formatDuration(duration)}`
    )
  }

  async handleLLMError(err: Error, runId: string): Promise<void> {
    const startTime = startTimes.get(`llm:${runId}`)
    const duration = startTime ? Date.now() - startTime : 0
    startTimes.delete(`llm:${runId}`)

    logger.error(
      { runId, duration, durationFormatted: formatDuration(duration), error: err.message },
      `[LLM ERROR] after ${formatDuration(duration)}: ${err.message}`
    )
  }

  // Tool Events
  async handleToolStart(tool: Serialized, input: string, runId: string): Promise<void> {
    startTimes.set(`tool:${runId}`, Date.now())
    const toolName = tool.id?.[tool.id.length - 1] ?? "unknown"
    const inputPreview = typeof input === "string" ? input.slice(0, 100) : JSON.stringify(input).slice(0, 100)
    logger.info({ runId, toolName, inputPreview }, `[TOOL START] ${toolName}`)
  }

  async handleToolEnd(output: string, runId: string): Promise<void> {
    const startTime = startTimes.get(`tool:${runId}`)
    const duration = startTime ? Date.now() - startTime : 0
    startTimes.delete(`tool:${runId}`)

    const outputPreview = typeof output === "string" ? output.slice(0, 100) : JSON.stringify(output).slice(0, 100)
    logger.info(
      { runId, duration, durationFormatted: formatDuration(duration), outputPreview },
      `[TOOL END] ${formatDuration(duration)}`
    )
  }

  async handleToolError(err: Error, runId: string): Promise<void> {
    const startTime = startTimes.get(`tool:${runId}`)
    const duration = startTime ? Date.now() - startTime : 0
    startTimes.delete(`tool:${runId}`)

    logger.error(
      { runId, duration, durationFormatted: formatDuration(duration), error: err.message },
      `[TOOL ERROR] after ${formatDuration(duration)}: ${err.message}`
    )
  }

  // Chain Events (includes graph nodes)
  async handleChainStart(chain: Serialized, inputs: ChainValues, runId: string): Promise<void> {
    startTimes.set(`chain:${runId}`, Date.now())
    const chainName = chain.id?.[chain.id.length - 1] ?? "unknown"
    logger.info({ runId, chainName }, `[CHAIN START] ${chainName}`)
  }

  async handleChainEnd(outputs: ChainValues, runId: string): Promise<void> {
    const startTime = startTimes.get(`chain:${runId}`)
    const duration = startTime ? Date.now() - startTime : 0
    startTimes.delete(`chain:${runId}`)

    logger.info(
      { runId, duration, durationFormatted: formatDuration(duration) },
      `[CHAIN END] ${formatDuration(duration)}`
    )
  }

  async handleChainError(err: Error, runId: string): Promise<void> {
    const startTime = startTimes.get(`chain:${runId}`)
    const duration = startTime ? Date.now() - startTime : 0
    startTimes.delete(`chain:${runId}`)

    logger.error(
      { runId, duration, durationFormatted: formatDuration(duration), error: err.message },
      `[CHAIN ERROR] after ${formatDuration(duration)}: ${err.message}`
    )
  }
}

/**
 * Create debug callbacks array for LangChain/LangGraph.
 *
 * Returns empty array if LANGGRAPH_DEBUG is not set to "true".
 * Safe to spread into callbacks array unconditionally.
 */
export function getDebugCallbacks(): DebugCallback[] {
  if (!isDebugEnabled()) {
    return []
  }
  return [new DebugCallback()]
}
