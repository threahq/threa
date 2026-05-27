/**
 * Cost Tracking Callback for LangChain
 *
 * Automatically records AI usage costs when LLM calls complete.
 * This eliminates the "do thing then call other thing" drift pattern
 * by baking cost recording into the callback chain.
 *
 * Usage:
 * ```typescript
 * const result = await costTracker.runWithTracking(async () => {
 *   return compiledGraph.invoke(input, {
 *     callbacks: [
 *       ...getLangfuseCallbacks({ ... }),
 *       ...getCostTrackingCallbacks({
 *         costRecorder,
 *         workspaceId,
 *         functionId: "companion-response",
 *         origin: "user",
 *         getCapturedUsage: () => costTracker.getCapturedUsage(),
 *       }),
 *     ],
 *   })
 * })
 * // Cost recording happens automatically - no manual step needed!
 * ```
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import type { LLMResult } from "@langchain/core/outputs"
import type { CostRecorder, AIOrigin, UsageWithCost } from "./ai"
import type { CapturedUsage } from "./openrouter-cost-interceptor"
import { logger } from "../logger"

export interface CostTrackingCallbackParams {
  /** Cost recorder instance to persist usage data */
  costRecorder: CostRecorder
  /** Workspace ID - required for cost attribution */
  workspaceId: string
  /** Optional user ID - the user who initiated this action (for user-origin calls) */
  userId?: string
  /** Optional session ID for grouping related calls */
  sessionId?: string
  /** Function ID for categorizing the operation */
  functionId: string
  /** Origin of the call - system or user initiated */
  origin: AIOrigin
  /** Function to get captured usage from CostTracker */
  getCapturedUsage: () => CapturedUsage
}

/**
 * LangChain callback handler that automatically records costs when LLM calls complete.
 *
 * The callback reads usage data from the CostTracker (via getCapturedUsage) and
 * records it to the database when handleLLMEnd fires.
 */
export class CostTrackingCallback extends BaseCallbackHandler {
  name = "cost-tracking"

  constructor(private params: CostTrackingCallbackParams) {
    super()
  }

  async handleLLMEnd(output: LLMResult): Promise<void> {
    const usage = this.params.getCapturedUsage()

    logger.debug(
      {
        functionId: this.params.functionId,
        usage,
        llmOutputModel: output.llmOutput?.model,
        llmOutputModelName: output.llmOutput?.modelName,
      },
      "CostTrackingCallback handleLLMEnd fired"
    )

    // Only record if there's actual cost or usage
    if (usage.cost === 0 && usage.totalTokens === 0) {
      logger.debug({ functionId: this.params.functionId }, "Skipping cost recording - no usage")
      return
    }

    // Extract model from LLM output if available
    const model = (output.llmOutput?.model as string) ?? (output.llmOutput?.modelName as string) ?? "unknown"

    try {
      await this.params.costRecorder.recordUsage({
        workspaceId: this.params.workspaceId,
        userId: this.params.userId,
        sessionId: this.params.sessionId,
        functionId: this.params.functionId,
        model,
        provider: "openrouter",
        origin: this.params.origin,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          cost: usage.cost,
        } satisfies UsageWithCost,
      })

      logger.debug(
        {
          workspaceId: this.params.workspaceId,
          sessionId: this.params.sessionId,
          functionId: this.params.functionId,
          model,
          cost: usage.cost,
          totalTokens: usage.totalTokens,
        },
        "Cost tracking callback recorded usage"
      )
    } catch (error) {
      logger.error(
        {
          error,
          workspaceId: this.params.workspaceId,
          sessionId: this.params.sessionId,
          functionId: this.params.functionId,
        },
        "Failed to record usage in cost tracking callback"
      )
    }
  }
}

/**
 * Create cost tracking callbacks array for LangChain/LangGraph.
 *
 * Returns empty array if no costRecorder is provided, allowing safe spreading:
 * ```typescript
 * callbacks: [
 *   ...getLangfuseCallbacks({ ... }),
 *   ...getCostTrackingCallbacks({ ... }), // safe even if no costRecorder
 * ]
 * ```
 *
 * @param params - Parameters for cost tracking (costRecorder can be undefined)
 * @returns Array with CostTrackingCallback, or empty array if no costRecorder
 */
export function getCostTrackingCallbacks(
  params: Partial<CostTrackingCallbackParams> & { workspaceId?: string }
): CostTrackingCallback[] {
  // Return empty array if essential params are missing
  if (!params.costRecorder || !params.workspaceId || !params.functionId || !params.getCapturedUsage) {
    return []
  }

  return [
    new CostTrackingCallback({
      costRecorder: params.costRecorder,
      workspaceId: params.workspaceId,
      userId: params.userId,
      sessionId: params.sessionId,
      functionId: params.functionId,
      origin: params.origin ?? "system",
      getCapturedUsage: params.getCapturedUsage,
    }),
  ]
}
