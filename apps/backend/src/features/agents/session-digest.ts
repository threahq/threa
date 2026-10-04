import type { Pool } from "pg"
import { parseTurnDigestStepContent } from "@threahq/agent-runtime"
import { AgentStepTypes, AuthorTypes, type TurnDigestStepContent } from "@threahq/types"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository, type AgentSession } from "./session-repository"

export interface SessionDigest {
  /**
   * Labeled condensation of the session's own trace: the trigger message, the
   * `turn_digest` research findings, and the persona's replies. The single input
   * shared by the episode summarizer (roadmap 3.1) and the reflective memo
   * capture (roadmap 6.3) — both distil the same session, so they read it once
   * from one place (INV-35).
   */
  text: string
  /** At least one `turn_digest` step carried research findings — the reflective-capture gate. */
  hasResearch: boolean
  /**
   * The session's own in-stream message a reflective memo anchors to (roadmap
   * 6.3): the real trigger message when it exists, else the last real reply.
   * NULL when the session has no real message at all — a synthetic follow-up
   * trigger (`followup_…`, no row) that never replied — so reflective capture
   * has nothing to anchor and skips it.
   */
  anchorMessageId: string | null
  /** The human who wrote the trigger message; null when the trigger is synthetic or not a user's. */
  triggerAuthorUserId: string | null
  /** Distinct human authors across the trigger + replies (a memo's `participant_ids`). */
  participantUserIds: string[]
  /** Streams the research cited, across every turn digest. */
  citedStreamIds: string[]
  /** Messages the research cited, across every turn digest. */
  citedMessageIds: string[]
}

/**
 * Assemble a session's digest from its own trace. Single pooled reads, no
 * connection held across anything slow (INV-30/41). Returns null when there is
 * nothing to condense (no trigger text, no findings, no replies).
 */
export async function buildSessionDigest(pool: Pool, session: AgentSession): Promise<SessionDigest | null> {
  const sections: string[] = []
  const participantUserIds = new Set<string>()

  // A fired follow-up carries a synthetic `followup_<id>` trigger with no real
  // message row, so findById returns null — the session's other signals stand.
  const trigger = await MessageRepository.findById(pool, session.workspaceId, session.triggerMessageId)
  if (trigger) {
    if (trigger.authorType === AuthorTypes.USER) participantUserIds.add(trigger.authorId)
    if (trigger.contentMarkdown.trim()) sections.push(`Trigger message:\n${trigger.contentMarkdown.trim()}`)
  }

  const steps = await AgentSessionRepository.findStepsBySession(pool, session.workspaceId, session.id)
  const digests = steps
    .filter((s) => s.stepType === AgentStepTypes.TURN_DIGEST)
    .map((s) => parseTurnDigestStepContent(s.content))
    .filter((d): d is TurnDigestStepContent => d !== null)
  const hasResearch = digests.length > 0
  if (hasResearch) {
    sections.push(`What the assistant researched:\n${digests.map((d) => d.findings.trim()).join("\n\n")}`)
  }

  // Prefer the real trigger as the anchor; otherwise fall back to the last real reply.
  let anchorMessageId: string | null = trigger ? trigger.id : null
  if (session.sentMessageIds.length > 0) {
    const sent = await MessageRepository.findByIds(pool, session.workspaceId, session.sentMessageIds)
    const replies: string[] = []
    for (const id of session.sentMessageIds) {
      const msg = sent.get(id)
      if (!msg) continue
      if (msg.authorType === AuthorTypes.USER) participantUserIds.add(msg.authorId)
      if (msg.contentMarkdown.trim()) replies.push(msg.contentMarkdown.trim())
    }
    if (!anchorMessageId) {
      const lastRealReply = [...session.sentMessageIds].reverse().find((id) => sent.has(id))
      anchorMessageId = lastRealReply ?? null
    }
    if (replies.length > 0) sections.push(`What the assistant replied:\n${replies.join("\n\n")}`)
  }

  if (sections.length === 0) return null

  return {
    text: sections.join("\n\n"),
    hasResearch,
    anchorMessageId,
    triggerAuthorUserId: trigger?.authorType === AuthorTypes.USER ? trigger.authorId : null,
    participantUserIds: Array.from(participantUserIds),
    citedStreamIds: [...new Set(digests.flatMap((d) => d.sourceStreamIds))],
    citedMessageIds: [...new Set(digests.flatMap((d) => d.sources.flatMap((s) => (s.messageId ? [s.messageId] : []))))],
  }
}
