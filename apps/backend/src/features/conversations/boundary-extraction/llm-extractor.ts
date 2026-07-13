import { NoObjectGeneratedError } from "ai"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import type {
  AttachmentExtractContext,
  BoundaryExtractor,
  ExtractionContext,
  ExtractionResult,
  MessageAssignment,
  Reassignment,
  SplitContext,
  SplitProposal,
  SplitGroup,
} from "./types"
import type { Message } from "../../messaging"
import { renderLinkPreviewContext } from "../../link-previews"
import { logger } from "../../../lib/logger"
import { StreamTypes } from "@threa/types"
import {
  extractionResponseSchema,
  BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
  BOUNDARY_EXTRACTION_PROMPT,
  NEW_MESSAGE_ATTACHMENT_CHARS,
  RECENT_ATTACHMENT_CHARS,
  CONVERSATION_SPLIT_SYSTEM_PROMPT,
  CONVERSATION_SPLIT_PROMPT,
  conversationSplitResponseSchema,
  type ExtractionResponse,
  type ConversationSplitResponse,
} from "./config"

/** Below this, a conversation is too short to split meaningfully — skip the AI call. */
const MIN_MESSAGES_TO_SPLIT = 4

/**
 * Upper bound on the messages fed into one split prompt. A drifted conversation
 * can in principle be large; without a cap the prompt is unbounded and can
 * exceed what `applySplit` will accept on confirm (its 500-message ceiling),
 * wasting the call. We consider the most recent window — older messages beyond
 * it stay in the source conversation (the apply path only moves messages that
 * land in a proposed group). Kept under the apply ceiling so a proposal always
 * fits.
 */
const MAX_SPLIT_MESSAGES = 300

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n")
}

/**
 * Age of `date` relative to `reference` (the new message), rendered for the
 * prompt: "just now", "5m ago", "3h ago", "2d ago". Ages at or after the
 * reference clamp to "just now" — `recentMessages` includes a couple of
 * messages sent AFTER the new message (MESSAGES_AFTER), and their sub-minute
 * skew carries no boundary signal.
 */
export function formatRelativeAge(date: Date, reference: Date): string {
  const minutes = Math.floor((reference.getTime() - date.getTime()) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  // Hours up to two days: "26h ago" carries the overnight-vs-full-day nuance
  // that "1d ago" would flatten, and that nuance is exactly what the model
  // weighs at session boundaries.
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export class LLMBoundaryExtractor implements BoundaryExtractor {
  constructor(
    private ai: AI,
    private configResolver: ConfigResolver
  ) {}

  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    // Cold-start: a thread with no active conversation and no parent message
    // conversation. There's nothing for the LLM to consider, so just create a
    // new conversation deterministically.
    if (
      context.streamType === StreamTypes.THREAD &&
      context.activeConversations.length === 0 &&
      (!context.parentMessageConversations || context.parentMessageConversations.length === 0)
    ) {
      return {
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: this.truncateAsTopic(context.newMessage),
        confidence: 1.0,
      }
    }

    const config = await this.configResolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    const prompt = this.buildPrompt(context)

    try {
      const { value } = await this.ai.generateObject({
        model: config.modelId,
        schema: extractionResponseSchema,
        messages: [
          { role: "system", content: config.systemPrompt ?? BOUNDARY_EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        telemetry: {
          functionId: "boundary-extraction",
          metadata: {
            streamType: context.streamType,
            activeConversationCount: context.activeConversations.length,
            parentConversationCount: context.parentMessageConversations?.length ?? 0,
          },
        },
        context: { workspaceId: context.workspaceId, origin: "system" },
      })

      return this.validateResult(value, context)
    } catch (error) {
      // Handle parsing errors gracefully - LLMs sometimes return JSON wrapped in markdown
      // This is NOT a silent fallback per INV-11: we log the error and only handle this
      // specific error type. API errors, rate limits, etc. still propagate for retry.
      if (error instanceof NoObjectGeneratedError) {
        logger.warn(
          { error: error.message, text: error.text?.slice(0, 200) },
          "LLM returned unparseable response, treating as new conversation"
        )
        return {
          assignments: [{ conversationId: null, isPrimary: true }],
          newConversationTopic: this.truncateAsTopic(context.newMessage),
          confidence: 0.5,
        }
      }
      throw error
    }
  }

  async splitConversation(context: SplitContext): Promise<SplitProposal> {
    // Too short (or empty) to split — return the whole thing as one group without
    // an AI call. `groups.length === 1` is the caller's "no split needed" signal.
    // An empty conversation (a resolved/emptied thread-split shell) lands here too.
    if (context.messages.length < MIN_MESSAGES_TO_SPLIT) {
      return {
        groups: [{ title: this.splitFallbackTitle(context), messageIds: context.messages.map((m) => m.id) }],
        confidence: 1.0,
        reasoning: "Conversation is too short to split.",
      }
    }

    // Bound the prompt: consider only the most recent MAX_SPLIT_MESSAGES. Anything
    // older stays in the source (apply only moves messages that land in a group),
    // and the proposal always fits applySplit's ceiling.
    const scoped =
      context.messages.length > MAX_SPLIT_MESSAGES
        ? { ...context, messages: context.messages.slice(-MAX_SPLIT_MESSAGES) }
        : context
    if (scoped !== context) {
      logger.info(
        { conversationId: context.conversationId, total: context.messages.length, considered: MAX_SPLIT_MESSAGES },
        "Conversation exceeds the split window — splitting the most recent messages only"
      )
    }

    const config = await this.configResolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    const prompt = this.buildSplitPrompt(scoped)

    try {
      const { value } = await this.ai.generateObject({
        model: config.modelId,
        schema: conversationSplitResponseSchema,
        messages: [
          { role: "system", content: CONVERSATION_SPLIT_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: config.temperature,
        telemetry: {
          functionId: "conversation-split",
          metadata: { streamType: scoped.streamType, messageCount: scoped.messages.length },
        },
        context: { workspaceId: scoped.workspaceId, origin: "user" },
      })

      return this.validateSplit(value, scoped)
    } catch (error) {
      // Same narrow handling as extract(): an unparseable object degrades to "no
      // split" (INV-11 — not a silent fallback: logged, and only this error type;
      // API/rate-limit errors still propagate for the request to surface).
      if (error instanceof NoObjectGeneratedError) {
        logger.warn(
          { conversationId: context.conversationId, text: error.text?.slice(0, 200) },
          "LLM returned unparseable split response, proposing no split"
        )
        return {
          groups: [{ title: this.splitFallbackTitle(scoped), messageIds: scoped.messages.map((m) => m.id) }],
          confidence: 0.0,
          reasoning: null,
        }
      }
      throw error
    }
  }

  /** Empty-safe title for a no-split proposal: the stored topic, else the first
   *  message's opening, else a neutral label (an emptied conversation has neither). */
  private splitFallbackTitle(context: SplitContext): string {
    if (context.topicSummary) return context.topicSummary
    const first = context.messages[0]
    return first ? this.truncateAsTopic(first) : "Conversation"
  }

  private buildSplitPrompt(context: SplitContext): string {
    const now = context.messages[context.messages.length - 1]?.createdAt ?? context.messages[0].createdAt
    const messagesSection = context.messages
      .map(
        (m) =>
          `[${m.id}] (${formatRelativeAge(m.createdAt, now)}) ${m.authorType}:${m.authorId.slice(-8)}: ${m.contentMarkdown.slice(0, 300)}${m.contentMarkdown.length > 300 ? "…" : ""}`
      )
      .join("\n")

    return CONVERSATION_SPLIT_PROMPT.replace("{{TITLE}}", context.topicSummary ?? "No title yet")
      .replace("{{SUMMARY}}", context.summary ? `Current summary: ${context.summary}` : "")
      .replace("{{MESSAGES}}", messagesSection)
  }

  /**
   * Coerce the raw response into a partition of the input messages: keep only
   * known ids, drop duplicates (first group wins), and sweep any message the
   * model left unassigned into the largest group so nothing is lost. Groups
   * emptied by that filtering are dropped; groups are ordered largest-first so
   * the caller keeps the most representative group as the source conversation.
   */
  private validateSplit(parsed: ConversationSplitResponse, context: SplitContext): SplitProposal {
    const validIds = new Set(context.messages.map((m) => m.id))
    const orderIndex = new Map(context.messages.map((m, i) => [m.id, i]))
    const assigned = new Set<string>()

    const groups: SplitGroup[] = []
    for (const g of parsed.groups) {
      const ids = g.messageIds.filter((id) => validIds.has(id) && !assigned.has(id))
      for (const id of ids) assigned.add(id)
      if (ids.length === 0) continue
      ids.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0))
      groups.push({ title: g.title, summary: g.summary ?? undefined, messageIds: ids })
    }

    // Nothing survived (all ids unknown) — treat as no split.
    if (groups.length === 0) {
      return {
        groups: [{ title: this.splitFallbackTitle(context), messageIds: [...validIds] }],
        confidence: parsed.confidence,
        reasoning: parsed.reasoning,
      }
    }

    // Order largest-first so the "kept" group (the caller keeps groups[0] in the
    // source conversation) is the most representative — fewest messages move.
    groups.sort((a, b) => b.messageIds.length - a.messageIds.length)

    // Sweep any unassigned messages into the largest group so the partition is
    // total (the apply path only moves messages that ARE in a group).
    const leftover = context.messages.map((m) => m.id).filter((id) => !assigned.has(id))
    if (leftover.length > 0) {
      const target = groups[0]
      target.messageIds = [...target.messageIds, ...leftover].sort(
        (a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0)
      )
    }

    return { groups, confidence: parsed.confidence, reasoning: parsed.reasoning }
  }

  private buildPrompt(context: ExtractionContext): string {
    const now = context.newMessage.createdAt
    const allConvs = [
      ...(context.parentMessageConversations ?? []).map((c) => ({ ...c, isParent: true })),
      ...context.activeConversations.map((c) => ({ ...c, isParent: false })),
    ]

    const convSection =
      allConvs.length > 0
        ? allConvs
            .map((c) => {
              const tag = c.isParent ? " [parent-thread]" : ""
              const contextIds =
                c.contextMessageIds.length > 0 ? `, in-context messages: [${c.contextMessageIds.join(", ")}]` : ""
              const summaryLine = c.summary ? `\n  covers: ${c.summary}` : ""
              return `- ${c.id}${tag}: "${c.topicSummary ?? "No topic yet"}" (status: ${c.status}, last active ${formatRelativeAge(c.lastActivityAt, now)}, ${c.messageCount} messages, completeness: ${c.completenessScore}/7, participants: ${c.participantIds.length}${contextIds})${summaryLine}`
            })
            .join("\n")
        : "No active conversations in this stream yet."

    const attachmentsByMessageId = context.attachmentsByMessageId ?? new Map()
    const linkPreviewsByMessageId = context.linkPreviewsByMessageId ?? new Map()

    const recentSection = context.recentMessages
      .map((m) => {
        const head = `[${m.id}] (${formatRelativeAge(m.createdAt, now)}) ${m.authorType}:${m.authorId.slice(-8)}: ${m.contentMarkdown.slice(0, 200)}${m.contentMarkdown.length > 200 ? "..." : ""}`
        const atts = attachmentsByMessageId.get(m.id)
        const attBlock = atts && atts.length > 0 ? `\n${this.renderAttachments(atts, RECENT_ATTACHMENT_CHARS)}` : ""
        const previewBlock = renderLinkPreviewContext(linkPreviewsByMessageId.get(m.id) ?? [])
        return head + attBlock + (previewBlock ? `\n${previewBlock}` : "")
      })
      .join("\n")

    const newMessageAtts = attachmentsByMessageId.get(context.newMessage.id) ?? []
    const newMessageAttachmentSection =
      newMessageAtts.length > 0 ? `\n${this.renderAttachments(newMessageAtts, NEW_MESSAGE_ATTACHMENT_CHARS)}` : ""
    const newMessagePreviewBlock = renderLinkPreviewContext(linkPreviewsByMessageId.get(context.newMessage.id) ?? [])
    const newMessagePreviewSection = newMessagePreviewBlock ? `\n${newMessagePreviewBlock}` : ""

    const replyTargets = context.replyTargets ?? []
    const replySection =
      replyTargets.length > 0
        ? replyTargets
            .map(
              (t) =>
                `- Quote-replies message [${t.quotedMessageId}], which is PRIMARY in conversation ${t.conversationId} ("${t.topicSummary ?? "No topic yet"}"). Quoted text: "${t.snippet}"`
            )
            .join("\n")
        : "None — this message does not quote-reply anything."

    return BOUNDARY_EXTRACTION_PROMPT.replace("{{CONVERSATIONS}}", convSection)
      .replace("{{RECENT_MESSAGES}}", recentSection || "No recent messages.")
      .replace("{{AUTHOR}}", `${context.newMessage.authorType}:${context.newMessage.authorId.slice(-8)}`)
      .replace(
        "{{CONTENT}}",
        context.newMessage.contentMarkdown + newMessageAttachmentSection + newMessagePreviewSection
      )
      .replace("{{REPLY_CONTEXT}}", replySection)
  }

  private renderAttachments(attachments: AttachmentExtractContext[], maxChars: number): string {
    const lines = attachments.map((a) => {
      const kind = a.contentType ?? a.mimeType
      // Prefer fullText (transcript / OCR / parse). Fall back to summary so the
      // model at least sees what the attachment is about when extraction is
      // still summary-only (or has no fullText, e.g. image captions).
      const body = (a.fullText ?? a.summary ?? "").trim()
      if (!body) return `  [attachment ${a.filename} (${kind}): no extracted content]`
      const truncated = body.length > maxChars ? body.slice(0, maxChars) + "…" : body
      return `  [attachment ${a.filename} (${kind})]:\n${indent(truncated, "    ")}`
    })
    return lines.join("\n")
  }

  private validateResult(parsed: ExtractionResponse, context: ExtractionContext): ExtractionResult {
    const validConvIds = new Set([
      ...context.activeConversations.map((c) => c.id),
      ...(context.parentMessageConversations ?? []).map((c) => c.id),
    ])

    const validAssignments: MessageAssignment[] = []
    for (const a of parsed.assignments) {
      if (a.conversationId !== null && !validConvIds.has(a.conversationId)) {
        logger.warn({ parsedId: a.conversationId }, "LLM returned invalid conversation ID in assignment - dropping")
        continue
      }
      validAssignments.push({ conversationId: a.conversationId, isPrimary: a.isPrimary })
    }

    let primaryCount = validAssignments.filter((a) => a.isPrimary).length
    if (validAssignments.length === 0 || primaryCount === 0) {
      logger.warn(
        { rawAssignments: parsed.assignments, validCount: validAssignments.length },
        "LLM returned no valid primary assignment, treating as new conversation"
      )
      return {
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: parsed.newConversationTopic ?? this.truncateAsTopic(context.newMessage),
        newConversationSummary: parsed.newConversationSummary ?? undefined,
        reassignments: undefined,
        completenessUpdates: this.normalizeCompletenessUpdates(parsed),
        confidence: parsed.confidence,
      }
    }

    if (primaryCount > 1) {
      let seenPrimary = false
      for (const a of validAssignments) {
        if (a.isPrimary) {
          if (seenPrimary) a.isPrimary = false
          else seenPrimary = true
        }
      }
      primaryCount = 1
    }

    // Validate reassignments: messageId must be in scope; toConversationId must be
    // a valid existing conv OR null (when this call creates a new conv).
    // buildPrompt exposes both active AND parent-thread contextMessageIds to the
    // model, so both must be reassignable — otherwise a valid thread-flow move
    // (e.g. "this thread message belongs to the parent's conversation") would be
    // silently dropped here.
    const candidateMessageIds = new Set<string>()
    for (const m of context.recentMessages) candidateMessageIds.add(m.id)
    for (const c of context.activeConversations) {
      for (const id of c.contextMessageIds) candidateMessageIds.add(id)
    }
    for (const c of context.parentMessageConversations ?? []) {
      for (const id of c.contextMessageIds) candidateMessageIds.add(id)
    }
    candidateMessageIds.delete(context.newMessage.id)

    const hasNewConv = validAssignments.some((a) => a.conversationId === null)

    const validReassignments: Reassignment[] = []
    for (const r of parsed.reassignments ?? []) {
      if (!candidateMessageIds.has(r.messageId)) {
        logger.warn({ messageId: r.messageId }, "LLM tried to reassign a message outside the candidate set - dropping")
        continue
      }
      if (r.toConversationId !== null && !validConvIds.has(r.toConversationId)) {
        logger.warn(
          { toConversationId: r.toConversationId },
          "LLM tried to reassign to an unknown conversation - dropping"
        )
        continue
      }
      if (r.toConversationId === null && !hasNewConv) {
        logger.warn(
          { messageId: r.messageId },
          "LLM tried to reassign to new conversation but no new conversation was created - dropping"
        )
        continue
      }
      validReassignments.push({
        messageId: r.messageId,
        toConversationId: r.toConversationId,
        reason: r.reason,
        confidence: r.confidence ?? undefined,
      })
    }

    const hasNullAssignment = validAssignments.some((a) => a.conversationId === null)
    const newConversationTopic = hasNullAssignment
      ? (parsed.newConversationTopic ?? this.truncateAsTopic(context.newMessage))
      : undefined

    return {
      assignments: validAssignments,
      newConversationTopic,
      newConversationSummary: hasNullAssignment ? (parsed.newConversationSummary ?? undefined) : undefined,
      reassignments: validReassignments.length > 0 ? validReassignments : undefined,
      completenessUpdates: this.normalizeCompletenessUpdates(parsed),
      confidence: parsed.confidence,
    }
  }

  /** Wire completeness updates carry `summary: string | null`; internal shape uses optional. */
  private normalizeCompletenessUpdates(parsed: ExtractionResponse): ExtractionResult["completenessUpdates"] {
    if (!parsed.completenessUpdates) return undefined
    return parsed.completenessUpdates.map((u) => ({
      conversationId: u.conversationId,
      score: u.score,
      status: u.status,
      summary: u.summary ?? undefined,
    }))
  }

  private truncateAsTopic(message: Message): string {
    const firstSentence = message.contentMarkdown.split(/[.!?\n]/)[0]?.trim()
    const text = firstSentence && firstSentence.length > 0 ? firstSentence : message.contentMarkdown.trim()

    if (text.length <= 100) {
      return text
    }

    // Find last space before the limit to avoid cutting mid-word.
    const lastSpace = text.lastIndexOf(" ", 99)
    if (lastSpace > 20) {
      return text.slice(0, lastSpace) + "…"
    }

    return text.slice(0, 99) + "…"
  }
}
