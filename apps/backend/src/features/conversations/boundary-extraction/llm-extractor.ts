import { NoObjectGeneratedError } from "ai"
import type { AI } from "../../../lib/ai/ai"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import type {
  AttachmentExtractContext,
  BoundaryExtractor,
  ExtractionContext,
  ExtractionResult,
  MessageAssignment,
  Reassignment,
} from "./types"
import type { Message } from "../../messaging"
import { logger } from "../../../lib/logger"
import { StreamTypes } from "@threa/types"
import {
  extractionResponseSchema,
  BOUNDARY_EXTRACTION_SYSTEM_PROMPT,
  BOUNDARY_EXTRACTION_PROMPT,
  type ExtractionResponse,
} from "./config"

/**
 * Per-attachment character budget when rendering extracted text in the prompt.
 * The new message's attachments get a bigger window because they are the
 * payload most likely to change the classification decision; context messages
 * use a smaller window (closer to a summary) to keep the prompt bounded.
 */
const NEW_MESSAGE_ATTACHMENT_CHARS = 2000
const RECENT_ATTACHMENT_CHARS = 400

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n")
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

  private buildPrompt(context: ExtractionContext): string {
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
              return `- ${c.id}${tag}: "${c.topicSummary ?? "No topic yet"}" (status: ${c.status}, ${c.messageCount} messages, completeness: ${c.completenessScore}/7, participants: ${c.participantIds.length}${contextIds})`
            })
            .join("\n")
        : "No active conversations in this stream yet."

    const attachmentsByMessageId = context.attachmentsByMessageId ?? new Map()

    const recentSection = context.recentMessages
      .map((m) => {
        const head = `[${m.id}] ${m.authorType}:${m.authorId.slice(-8)}: ${m.contentMarkdown.slice(0, 200)}${m.contentMarkdown.length > 200 ? "..." : ""}`
        const atts = attachmentsByMessageId.get(m.id)
        const attBlock = atts && atts.length > 0 ? `\n${this.renderAttachments(atts, RECENT_ATTACHMENT_CHARS)}` : ""
        return head + attBlock
      })
      .join("\n")

    const newMessageAtts = attachmentsByMessageId.get(context.newMessage.id) ?? []
    const newMessageAttachmentSection =
      newMessageAtts.length > 0 ? `\n${this.renderAttachments(newMessageAtts, NEW_MESSAGE_ATTACHMENT_CHARS)}` : ""

    return BOUNDARY_EXTRACTION_PROMPT.replace("{{CONVERSATIONS}}", convSection)
      .replace("{{RECENT_MESSAGES}}", recentSection || "No recent messages.")
      .replace("{{AUTHOR}}", `${context.newMessage.authorType}:${context.newMessage.authorId.slice(-8)}`)
      .replace("{{CONTENT}}", context.newMessage.contentMarkdown + newMessageAttachmentSection)
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

    // Filter assignments to only valid conversation IDs (or null for new).
    const validAssignments: MessageAssignment[] = []
    for (const a of parsed.assignments) {
      if (a.conversationId !== null && !validConvIds.has(a.conversationId)) {
        logger.warn({ parsedId: a.conversationId }, "LLM returned invalid conversation ID in assignment - dropping")
        continue
      }
      validAssignments.push({ conversationId: a.conversationId, isPrimary: a.isPrimary })
    }

    // Need at least one assignment with isPrimary=true. If nothing valid came back,
    // or no primary was set, treat as a new conversation.
    let primaryCount = validAssignments.filter((a) => a.isPrimary).length
    if (validAssignments.length === 0 || primaryCount === 0) {
      logger.warn(
        { rawAssignments: parsed.assignments, validCount: validAssignments.length },
        "LLM returned no valid primary assignment, treating as new conversation"
      )
      return {
        assignments: [{ conversationId: null, isPrimary: true }],
        newConversationTopic: parsed.newConversationTopic ?? this.truncateAsTopic(context.newMessage),
        reassignments: undefined,
        completenessUpdates: parsed.completenessUpdates ?? undefined,
        confidence: parsed.confidence,
      }
    }

    // If more than one primary came back, keep the first and demote the rest.
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
      reassignments: validReassignments.length > 0 ? validReassignments : undefined,
      completenessUpdates: parsed.completenessUpdates ?? undefined,
      confidence: parsed.confidence,
    }
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
