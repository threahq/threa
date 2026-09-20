import { isAbortError, rescaleScore, scoreAnswer, type AI, type DecisionQuestion } from "@threahq/agent-runtime"
import { logger } from "../../lib/logger"
import { RELEVANCE_SCORER_MODEL_ID, RELEVANCE_SCORER_TIMEOUT_MS, RELEVANCE_SCORE_LADDER } from "./config"
import type { RerankCandidate, RerankContext } from "./reranker"

/**
 * Relevance per candidate rather than an order over them.
 *
 * A permutation says which candidate is better; it cannot say whether any of
 * them is good. A number per candidate is what a relevance floor, an honest
 * "nothing matched" and cluster-ranking-by-best-member are all written against.
 *
 * `null` means no judgment was made. It is deliberately not an array of zeros:
 * a caller that cuts on the scores would empty the result list on every
 * failure, which is exactly the silent degradation INV-11 forbids.
 */
export interface RelevanceScorerLike {
  /** Relevance in [0, 1] aligned to the input order, or null when nothing was judged. */
  score(query: string, candidates: RerankCandidate[], context: RerankContext): Promise<number[] | null>
}

/**
 * Scores every candidate in one decisions call: the candidate list is the
 * shared state and each candidate gets its own ladder question, answered in
 * parallel against that one input. Sixty candidates cost one call, which is
 * why this can run on every search where the permutation reranker could not.
 *
 * Reached only by workspaces that have not pinned their AI residency;
 * `ResidencyRoutedRelevanceScorer` owns that choice.
 */
export class DecisionsRelevanceScorer implements RelevanceScorerLike {
  private readonly ai: AI
  private readonly subject: string
  private readonly functionId: string
  private readonly model: string
  private readonly timeoutMs: number

  constructor(config: {
    ai: AI
    /** Noun phrase describing the candidates, e.g. "chat messages". */
    subject: string
    functionId: string
    model?: string
    timeoutMs?: number
  }) {
    this.ai = config.ai
    this.subject = config.subject
    this.functionId = config.functionId
    this.model = config.model ?? RELEVANCE_SCORER_MODEL_ID
    this.timeoutMs = config.timeoutMs ?? RELEVANCE_SCORER_TIMEOUT_MS
  }

  async score(query: string, candidates: RerankCandidate[], context: RerankContext): Promise<number[] | null> {
    if (candidates.length === 0) return []

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("relevance scoring timeout")), this.timeoutMs)

    try {
      const questions: Record<string, DecisionQuestion> = {}
      candidates.forEach((_, index) => {
        questions[questionKey(index)] = {
          type: "score",
          instructions: `How well does candidate [${index}] in the candidates list answer the search query?`,
          criteria: [...RELEVANCE_SCORE_LADDER],
        }
      })

      const result = await this.ai.generateDecisions({
        model: this.model,
        state: {
          subject: this.subject,
          query,
          candidates: candidates.map((candidate, index) => ({
            index,
            ...(candidate.title === undefined ? {} : { title: candidate.title }),
            text: candidate.abstract,
          })),
        },
        questions,
        abortSignal: controller.signal,
        telemetry: { functionId: this.functionId, metadata: { candidateCount: candidates.length } },
        context: { workspaceId: context.workspaceId, userId: context.userId, origin: "user" },
      })

      return candidates.map((_, index) => rescaleScore(scoreAnswer(result, questionKey(index)), 1))
    } catch (error) {
      // A timeout is this class's own degradation and stops here: the search is
      // better served unscored than slow. Everything else belongs to the caller
      // that routes and holds the breaker, so it propagates.
      if (!isAbortError(error)) throw error
      logger.debug({ workspaceId: context.workspaceId }, "Relevance scoring timed out; leaving candidates unscored")
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function questionKey(index: number): string {
  return `c${index}`
}
