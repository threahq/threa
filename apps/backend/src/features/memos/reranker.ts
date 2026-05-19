import type { AI, CostContext } from "../../lib/ai/ai"
import { isAbortError } from "../../lib/ai/ai"
import { logger } from "../../lib/logger"
import { MEMO_RERANKER_MODEL_ID, MEMO_RERANKER_TEMPERATURE, MEMO_RERANKER_TIMEOUT_MS, memoRerankSchema } from "./config"

export interface RerankCandidate {
  title: string
  abstract: string
}

export interface RerankContext {
  workspaceId: string
  userId?: string
}

/**
 * B3 reranker. A pure enhancer over candidates that have *already* passed
 * the §3.1 access-scoped scan — it can only reorder, never widen
 * visibility. Fail-open on every failure reason (timeout, abort, model
 * error, malformed output): returns the input order unchanged so a
 * reranker problem can never block or shrink results.
 */
export interface RerankerLike {
  /** Returns a full permutation of `0..candidates.length-1` in descending relevance. */
  rerank(query: string, candidates: RerankCandidate[], context: RerankContext): Promise<number[]>
}

export interface RerankerServiceConfig {
  ai: AI
  model?: string
  timeoutMs?: number
}

function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * Coerce a model-proposed order into a valid full permutation: keep the
 * first occurrence of each in-range index, then append any candidates the
 * model omitted in their original order. This protects recall — a
 * candidate the model forgot is never dropped, only pushed to the tail.
 */
export function sanitizeOrder(proposed: number[], n: number): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []
  for (const idx of proposed) {
    if (Number.isInteger(idx) && idx >= 0 && idx < n && !seen.has(idx)) {
      seen.add(idx)
      ordered.push(idx)
    }
  }
  for (let i = 0; i < n; i++) {
    if (!seen.has(i)) ordered.push(i)
  }
  return ordered
}

export class MemoReranker implements RerankerLike {
  private readonly ai: AI
  private readonly model: string
  private readonly timeoutMs: number

  constructor(config: RerankerServiceConfig) {
    this.ai = config.ai
    this.model = config.model ?? MEMO_RERANKER_MODEL_ID
    this.timeoutMs = config.timeoutMs ?? MEMO_RERANKER_TIMEOUT_MS
  }

  async rerank(query: string, candidates: RerankCandidate[], context: RerankContext): Promise<number[]> {
    if (candidates.length <= 1) return identityOrder(candidates.length)

    const controller = new AbortController()
    const timer = setTimeout(() => {
      try {
        controller.abort(new DOMException("memo rerank timeout", "TimeoutError"))
      } catch {
        controller.abort(new Error("memo rerank timeout"))
      }
    }, this.timeoutMs)

    try {
      const list = candidates.map((c, i) => `[${i}] ${c.title}\n${c.abstract}`).join("\n\n")

      const costContext: CostContext = {
        workspaceId: context.workspaceId,
        userId: context.userId,
        origin: "system",
      }

      const { value } = await this.ai.generateObject({
        model: this.model,
        schema: memoRerankSchema,
        temperature: MEMO_RERANKER_TEMPERATURE,
        abortSignal: controller.signal,
        telemetry: {
          functionId: "memo-rerank",
          metadata: { candidateCount: candidates.length },
        },
        context: costContext,
        messages: [
          {
            role: "system",
            content:
              "You re-rank candidate knowledge memos by relevance to a search query. " +
              "Return only an `order` array of the candidate indices, most relevant first. " +
              "Include every index exactly once.",
          },
          {
            role: "user",
            content: `Query: ${query}\n\nCandidates:\n${list}`,
          },
        ],
      })

      return sanitizeOrder(value.order, candidates.length)
    } catch (error) {
      if (isAbortError(error)) {
        logger.debug({ workspaceId: context.workspaceId }, "Memo rerank timed out; using pre-rerank order")
      } else {
        logger.warn({ error, workspaceId: context.workspaceId }, "Memo rerank failed; using pre-rerank order")
      }
      return identityOrder(candidates.length)
    } finally {
      clearTimeout(timer)
    }
  }
}
