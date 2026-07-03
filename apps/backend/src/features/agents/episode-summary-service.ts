import type { Pool } from "pg"
import type { AI } from "@threa/agent-runtime"
import { parseTurnDigestStepContent } from "@threa/agent-runtime"
import { AgentStepTypes } from "@threa/types"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { logger } from "../../lib/logger"

export interface EpisodeSummaryServiceDeps {
  pool: Pool
  ai: AI
  modelId: string
  temperature: number
  maxTokens: number
}

/** Hard cap on the stored summary so a runaway model can't bloat the prompt insert. */
const MAX_SUMMARY_CHARS = 600

/**
 * Writes an `agent_sessions.episode_summary` after a companion session completes
 * (roadmap 3.1): a ~2-3 sentence condensation of what the persona did and
 * concluded, replayed into later turns as the "Previous sessions" context so
 * "as we discussed last week" survives the context window scrolling past.
 *
 * Reuses the conversation-summary worker pattern (cheap model, low temperature,
 * telemetry) but summarizes a *whole session* — trigger, tool findings, and the
 * reply it landed — not a rolling fold over dropped messages. INV-41: every DB
 * read/write is a single pooled query and no connection is held across the
 * summarizer AI call.
 */
export class EpisodeSummaryService {
  constructor(private readonly deps: EpisodeSummaryServiceDeps) {}

  /**
   * Summarize one completed session and persist it. Idempotent and defensive:
   * no-ops (no AI call) when the row is gone, not yet completed, already
   * summarized, or produced nothing worth condensing. The `setEpisodeSummary`
   * CAS on `IS NULL` makes a redelivered job or a concurrent summarizer safe.
   */
  async summarize(params: { workspaceId: string; sessionId: string }): Promise<{ written: boolean }> {
    const { workspaceId, sessionId } = params
    const { pool } = this.deps

    const session = await AgentSessionRepository.findById(pool, sessionId)
    if (!session) {
      logger.debug({ sessionId }, "episode summary skipped — session not found")
      return { written: false }
    }
    if (session.status !== SessionStatuses.COMPLETED || session.episodeSummary !== null) {
      // Not completed (nothing to summarize yet) or already summarized (idempotent).
      return { written: false }
    }

    const transcript = await this.buildTranscript(session.triggerMessageId, session.sentMessageIds, sessionId)
    if (!transcript) {
      logger.debug({ sessionId }, "episode summary skipped — no summarizable content")
      return { written: false }
    }

    const { value } = await this.deps.ai.generateText({
      model: this.deps.modelId,
      temperature: this.deps.temperature,
      maxTokens: this.deps.maxTokens,
      telemetry: {
        functionId: "agent.episode-summary",
        metadata: { workspace_id: workspaceId, session_id: sessionId },
      },
      context: { workspaceId, sessionId, origin: "system" },
      messages: [
        {
          role: "system",
          content: [
            "You write a terse episode summary of one assistant work session so a future session can recall it.",
            "In 2-3 sentences, past tense, capture: what prompted the session, what the assistant did or found, and what it concluded.",
            "Be concrete — keep specific decisions, facts, and unresolved questions. No preamble, no bullet lists, no meta commentary.",
          ].join(" "),
        },
        { role: "user", content: transcript },
      ],
    })

    const summary = value.trim().slice(0, MAX_SUMMARY_CHARS)
    if (!summary) {
      logger.debug({ sessionId }, "episode summary skipped — model returned empty text")
      return { written: false }
    }

    const written = await AgentSessionRepository.setEpisodeSummary(pool, sessionId, summary)
    logger.info({ sessionId, workspaceId, written }, "episode summary processed")
    return { written }
  }

  /**
   * Assemble the summarizer input from the session's own trace: the trigger
   * message (what prompted it), the persona's replies (what it concluded), and
   * any `turn_digest` findings (what the tools surfaced). Returns null when
   * there's nothing to condense. Reads are single pooled queries (INV-30).
   */
  private async buildTranscript(
    triggerMessageId: string,
    sentMessageIds: string[],
    sessionId: string
  ): Promise<string | null> {
    const { pool } = this.deps
    const sections: string[] = []

    // A fired follow-up carries a synthetic `followup_<id>` trigger with no real
    // message row, so findById returns null — the session's other signals stand.
    const trigger = await MessageRepository.findById(pool, triggerMessageId)
    if (trigger?.contentMarkdown.trim()) {
      sections.push(`Trigger message:\n${trigger.contentMarkdown.trim()}`)
    }

    const steps = await AgentSessionRepository.findStepsBySession(pool, sessionId)
    const findings = steps
      .filter((s) => s.stepType === AgentStepTypes.TURN_DIGEST)
      .map((s) => parseTurnDigestStepContent(s.content)?.findings?.trim())
      .filter((f): f is string => !!f)
    if (findings.length > 0) {
      sections.push(`What the assistant researched:\n${findings.join("\n\n")}`)
    }

    if (sentMessageIds.length > 0) {
      const sent = await MessageRepository.findByIds(pool, sentMessageIds)
      const replies = sentMessageIds.map((id) => sent.get(id)?.contentMarkdown.trim()).filter((c): c is string => !!c)
      if (replies.length > 0) {
        sections.push(`What the assistant replied:\n${replies.join("\n\n")}`)
      }
    }

    return sections.length > 0 ? sections.join("\n\n") : null
  }
}
