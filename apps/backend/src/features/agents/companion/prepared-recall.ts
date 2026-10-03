import type { KnowledgeType } from "@threahq/types"
import type { AnalyticsReporter } from "@threahq/backend-common"
import type { MemoExplorerService, RelevanceScorerLike } from "../../memos"
import { logger } from "../../../lib/logger"
import { escapeXmlAttr } from "../../../lib/xml"
import {
  PREPARED_RECALL_CANDIDATE_LIMIT,
  PREPARED_RECALL_MAX_MEMOS,
  PREPARED_RECALL_MIN_SCORE,
  PREPARED_RECALL_QUERY_MAX_CHARS,
  PREPARED_RECALL_TIMEOUT_MS,
} from "./config"

export interface RecalledMemo {
  id: string
  title: string
  abstract: string
  knowledgeType: KnowledgeType
  sourceMessageIds: string[]
  createdAt: Date
  score: number
}

export interface PreparedRecallParams {
  workspaceId: string
  invokingUserId: string
  query: string
  accessibleStreamIds: Set<string>
  /** Set only for a turn private to its user; admits that user's own memos (`resolveMemoViewer`). */
  memoViewerUserId: string | undefined
}

export const PREPARED_RECALL_EVENT = "prepared_recall"

type RecallOutcome = "recalled" | "nothing_relevant" | "no_candidates" | "unscored" | "timeout" | "failed"

interface Found {
  outcome: RecallOutcome
  candidateCount: number
  memos: RecalledMemo[]
}

/**
 * The memos a reply to this message should take into account, found before the
 * model runs so it never has to think of searching. Candidates come from the
 * same access-scoped memo search the explorer uses, so nothing outside the
 * turn's audience can be recalled; the scorer only drops candidates.
 *
 * An unscored pool recalls nothing: fusion order says what is similar, not what
 * matters, and injecting it every turn would be noise the model has to ignore.
 * That happens for residency-pinned workspaces and when the decision model is
 * unavailable, and is counted. `workspace_research` stays the deep path either way.
 * Recall is enrichment: past its deadline or on failure the turn goes on without it.
 */
export class PreparedRecall {
  private readonly memoExplorerService: Pick<MemoExplorerService, "search">
  private readonly scorer: RelevanceScorerLike
  private readonly analyticsReporter: AnalyticsReporter
  private readonly timeoutMs: number

  constructor(deps: {
    memoExplorerService: Pick<MemoExplorerService, "search">
    scorer: RelevanceScorerLike
    analyticsReporter: AnalyticsReporter
    timeoutMs?: number
  }) {
    this.memoExplorerService = deps.memoExplorerService
    this.scorer = deps.scorer
    this.analyticsReporter = deps.analyticsReporter
    this.timeoutMs = deps.timeoutMs ?? PREPARED_RECALL_TIMEOUT_MS
  }

  async recall(params: PreparedRecallParams): Promise<RecalledMemo[]> {
    const startedAt = Date.now()
    let found: Found = { outcome: "failed", candidateCount: 0, memos: [] }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs)
    })
    try {
      const result = await Promise.race([this.find(params), deadline])
      if (result === "timeout") {
        found = { outcome: "timeout", candidateCount: 0, memos: [] }
        logger.warn({ workspaceId: params.workspaceId, timeoutMs: this.timeoutMs }, "Prepared recall timed out")
      } else {
        found = result
      }
    } catch (error) {
      logger.warn({ err: error, workspaceId: params.workspaceId }, "Prepared recall failed")
    } finally {
      clearTimeout(timer)
    }

    const durationMs = Date.now() - startedAt
    if (found.outcome !== "timeout" && found.outcome !== "failed") {
      logger.info(
        {
          workspaceId: params.workspaceId,
          outcome: found.outcome,
          candidateCount: found.candidateCount,
          recalledMemoIds: found.memos.map((memo) => memo.id),
          durationMs,
        },
        "Prepared recall"
      )
    }
    // A workspace-grouped service event with no person profile and no content,
    // so retrieval latency and hit rate are counted for every turn.
    this.analyticsReporter.captureEvent({
      distinctId: `workspace:${params.workspaceId}`,
      event: PREPARED_RECALL_EVENT,
      properties: {
        outcome: found.outcome,
        candidateCount: found.candidateCount,
        recalledCount: found.memos.length,
        durationMs,
        $process_person_profile: false,
      },
      groups: { workspace: params.workspaceId },
    })
    return found.memos
  }

  private async find(params: PreparedRecallParams): Promise<Found> {
    const { workspaceId, invokingUserId, accessibleStreamIds, memoViewerUserId } = params
    const query = params.query.trim().slice(0, PREPARED_RECALL_QUERY_MAX_CHARS)
    if (!query || accessibleStreamIds.size === 0) return { outcome: "no_candidates", candidateCount: 0, memos: [] }

    const candidates = await this.memoExplorerService.search({
      workspaceId,
      permissions: { accessibleStreamIds: [...accessibleStreamIds], userId: memoViewerUserId },
      query,
      limit: PREPARED_RECALL_CANDIDATE_LIMIT,
      mode: "fast",
      // The memo a reply needs is often far from the message in embedding space
      // (a Thai menu vs a peanut allergy); the scorer, not distance, decides.
      semanticDistanceThreshold: null,
    })
    if (candidates.length === 0) return { outcome: "no_candidates", candidateCount: 0, memos: [] }

    const scores = await this.scorer.score(
      query,
      candidates.map(({ memo }) => ({ title: memo.title, abstract: memo.abstract })),
      { workspaceId, userId: invokingUserId }
    )
    if (!scores) return { outcome: "unscored", candidateCount: candidates.length, memos: [] }

    const memos = candidates
      .map(({ memo }, index) => ({
        id: memo.id,
        title: memo.title,
        abstract: memo.abstract,
        knowledgeType: memo.knowledgeType,
        sourceMessageIds: memo.sourceMessageIds,
        createdAt: memo.createdAt,
        score: scores[index],
      }))
      .filter((memo) => memo.score >= PREPARED_RECALL_MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, PREPARED_RECALL_MAX_MEMOS)

    return { outcome: memos.length > 0 ? "recalled" : "nothing_relevant", candidateCount: candidates.length, memos }
  }
}

export function formatRecalledMemosBlock(memos: RecalledMemo[]): string | null {
  if (memos.length === 0) return null
  const entries = memos.map(
    (memo) =>
      `<memo id="${escapeXmlAttr(memo.id)}" title="${escapeXmlAttr(memo.title)}" type="${memo.knowledgeType}" captured="${memo.createdAt.toISOString().slice(0, 10)}">\n${escapeXmlAttr(memo.abstract)}\n</memo>`
  )
  return `## Recalled from memory

Workspace memory retrieved for the latest message before you started. Take what bears on your reply into account without being asked, and say so briefly when it changes your answer. Memos are summaries and can be out of date, so look further when the reply depends on a detail. Leave out memos that don't bear on the reply.

${entries.join("\n")}`
}
