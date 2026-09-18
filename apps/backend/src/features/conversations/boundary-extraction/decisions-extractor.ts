import type { AI, DecisionQuestion, DecisionsResult } from "@threahq/agent-runtime"
import { choiceAnswer, noulAnswer, rescaleScore, scoreAnswer } from "@threahq/agent-runtime"
import type { ConversationStatus } from "@threahq/types"
import { CONVERSATION_STATUSES } from "@threahq/types"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../../lib/ai/config-resolver"
import type {
  AttachmentExtractContext,
  CompletenessUpdate,
  ConversationSummary,
  ExtractionContext,
  ExtractionResult,
  MessageAssignment,
  Reassignment,
} from "./types"
import type { Message } from "../../messaging"
import { renderLinkPreviewContext } from "../../link-previews"
import { logger } from "../../../lib/logger"
import { coldStartThreadResult, formatRelativeAge, isColdStartThread, truncateAsTopic } from "./shared"
import {
  BOUNDARY_DECISIONS_MODEL_ID,
  BOUNDARY_NAMING_PROMPT,
  BOUNDARY_NAMING_SYSTEM_PROMPT,
  boundaryNamingResponseSchema,
  COMPLETENESS_INSTRUCTIONS,
  COMPLETENESS_LADDER,
  DECISION_REASSIGNMENT_FLOOR,
  DECISION_SECONDARY_FLOOR,
  DECISION_SUMMARY_STALE_FLOOR,
  NEW_CONVERSATION_CHOICE,
  NEW_MESSAGE_ATTACHMENT_CHARS,
  PLACEMENT_INSTRUCTIONS,
  REASSIGNMENT_INSTRUCTIONS,
  RECENT_ATTACHMENT_CHARS,
  SECONDARY_INSTRUCTIONS,
  STATUS_CRITERIA,
  STATUS_INSTRUCTIONS,
  SUMMARY_STALE_INSTRUCTIONS,
} from "./config"

/** Question-key prefixes. `::` cannot appear in a prefixed ULID, so a key splits unambiguously. */
const KEY = {
  placement: "placement",
  secondary: (id: string) => `secondary::${id}`,
  completeness: (id: string) => `completeness::${id}`,
  status: (id: string) => `status::${id}`,
  summaryStale: (id: string) => `summary_stale::${id}`,
  move: (id: string) => `move::${id}`,
}

/** The completeness ladder answers on its own index range; the domain scale is 1-7. */
const COMPLETENESS_MIN = 1
const COMPLETENESS_MAX = 7

/**
 * Boundary extraction as typed decisions instead of a prompt.
 *
 * The classification itself — where the message goes, how settled each
 * conversation is, which earlier messages were misplaced — is a set of
 * questions a decision model answers in parallel against one shared state. It
 * cannot write prose, so the words a placement needs are a second call to the
 * prose model, made only when an answer says they are needed: a new
 * conversation always needs a name, and an existing one needs a refreshed
 * "covers:" line only when the model judges the stored one has gone stale.
 *
 * Reached only by workspaces that have not pinned their AI residency
 * (`WorkspaceAIResidencyPolicy`), since the decision model runs in one region
 * only. `ResidencyRoutedBoundaryExtractor` owns that choice.
 */
export class DecisionsBoundaryExtractor {
  constructor(
    private ai: AI,
    private configResolver: ConfigResolver
  ) {}

  async extract(context: ExtractionContext): Promise<ExtractionResult> {
    if (isColdStartThread(context)) return coldStartThreadResult(context)

    const candidates = this.candidates(context)

    // Nothing to choose between: the message opens the stream's first
    // conversation. Skip the decision call and go straight for its name.
    if (candidates.length === 0) {
      return this.openNewConversation(context, [], 1.0)
    }

    const result = await this.ai.generateDecisions({
      model: BOUNDARY_DECISIONS_MODEL_ID,
      state: this.buildState(context, candidates),
      questions: this.buildQuestions(context, candidates),
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

    const placement = choiceAnswer(result, KEY.placement)
    const known = new Set(candidates.map((c) => c.id))
    if (!known.has(placement.choice) && placement.choice !== NEW_CONVERSATION_CHOICE) {
      logger.warn(
        { choice: placement.choice, workspaceId: context.workspaceId, streamType: context.streamType },
        "Decision model returned an unoffered placement choice; opening a new conversation"
      )
    }
    const primaryId = known.has(placement.choice) ? placement.choice : null
    const reassignments = this.readReassignments(result, context, candidates, primaryId)

    if (primaryId === null) {
      return this.openNewConversation(context, reassignments, placement.confidence)
    }

    const assignments: MessageAssignment[] = [{ conversationId: primaryId, isPrimary: true }]
    for (const c of candidates) {
      if (c.id === primaryId) continue
      if (noulAnswer(result, KEY.secondary(c.id)) >= DECISION_SECONDARY_FLOOR) {
        assignments.push({ conversationId: c.id, isPrimary: false })
      }
    }

    const joined = candidates.find((c) => c.id === primaryId)!
    const summary =
      noulAnswer(result, KEY.summaryStale(primaryId)) >= DECISION_SUMMARY_STALE_FLOOR
        ? ((await this.writeProse(context, this.conversationMessages(context, joined), { summary: true })).summary ??
          undefined)
        : undefined

    return {
      assignments,
      reassignments: reassignments.length > 0 ? reassignments : undefined,
      completenessUpdates: [this.readCompleteness(result, primaryId, summary)],
      confidence: placement.confidence,
    }
  }

  /** The conversations the message could be placed in, parent-thread ones first (as the prompt path orders them). */
  private candidates(context: ExtractionContext): ConversationSummary[] {
    return [...(context.parentMessageConversations ?? []), ...context.activeConversations]
  }

  private async openNewConversation(
    context: ExtractionContext,
    reassignments: Reassignment[],
    confidence: number
  ): Promise<ExtractionResult> {
    const moving = new Set(reassignments.filter((r) => r.toConversationId === null).map((r) => r.messageId))
    const messages = [...context.recentMessages.filter((m) => moving.has(m.id)), context.newMessage]
    const prose = await this.writeProse(context, messages, { title: true, summary: true })

    return {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: prose.title ?? truncateAsTopic(context.newMessage),
      newConversationSummary: prose.summary ?? undefined,
      reassignments: reassignments.length > 0 ? reassignments : undefined,
      confidence,
    }
  }

  private readCompleteness(result: DecisionsResult, conversationId: string, summary?: string): CompletenessUpdate {
    const ladder = scoreAnswer(result, KEY.completeness(conversationId))
    const score =
      COMPLETENESS_MIN + rescaleScore(ladder, COMPLETENESS_LADDER.length, COMPLETENESS_MAX - COMPLETENESS_MIN)
    const status = choiceAnswer(result, KEY.status(conversationId)).choice

    return {
      conversationId,
      score: Math.round(score),
      status: (CONVERSATION_STATUSES as readonly string[]).includes(status) ? (status as ConversationStatus) : "active",
      summary,
    }
  }

  /**
   * An earlier message the model says shares a topic with the new one, but that
   * sits in a different conversation today, moves to where the new message
   * landed. `toConversationId: null` means the conversation being opened this
   * turn, which is why the primary is resolved before this runs.
   */
  private readReassignments(
    result: DecisionsResult,
    context: ExtractionContext,
    candidates: ConversationSummary[],
    primaryId: string | null
  ): Reassignment[] {
    const moves: Reassignment[] = []
    for (const [messageId, currentId] of this.placedMessages(context, candidates)) {
      if (currentId === primaryId) continue
      const belief = noulAnswer(result, KEY.move(messageId))
      if (belief < DECISION_REASSIGNMENT_FLOOR) continue
      moves.push({
        messageId,
        toConversationId: primaryId,
        // Diagnostic provenance only: the field rides the reassignment outbox
        // event and is never rendered.
        reason: `Same topic as the new message (belief ${belief.toFixed(2)})`,
        confidence: belief,
      })
    }
    return moves
  }

  /** Recent messages that already sit in one of the candidate conversations, and which one. */
  private placedMessages(context: ExtractionContext, candidates: ConversationSummary[]): Map<string, string> {
    const placed = new Map<string, string>()
    for (const c of candidates) {
      for (const id of c.contextMessageIds) {
        if (id !== context.newMessage.id && !placed.has(id)) placed.set(id, c.id)
      }
    }
    return placed
  }

  private conversationMessages(context: ExtractionContext, conversation: ConversationSummary): Message[] {
    const ids = new Set(conversation.contextMessageIds)
    return [
      ...context.recentMessages.filter((m) => ids.has(m.id) && m.id !== context.newMessage.id),
      context.newMessage,
    ]
  }

  /**
   * The one prose call: a title, a summary, or both, for a placement the
   * decisions call already settled. Runs on the boundary component's own model
   * and prompt config, so the two paths share one knob.
   */
  private async writeProse(
    context: ExtractionContext,
    messages: Message[],
    want: { title?: boolean; summary?: boolean }
  ): Promise<{ title: string | null; summary: string | null }> {
    const requests = [
      want.title ? "- title: a 2-5 word title for this conversation." : null,
      want.summary ? '- summary: a refreshed "covers:" summary of what it has discussed and where it landed.' : null,
      want.title ? null : "- title: null.",
      want.summary ? null : "- summary: null.",
    ].filter((line): line is string => line !== null)

    const config = await this.configResolver.resolve(COMPONENT_PATHS.BOUNDARY_EXTRACTION)
    const prompt = BOUNDARY_NAMING_PROMPT.replace("{{MESSAGES}}", this.renderMessages(context, messages)).replace(
      "{{REQUESTS}}",
      requests.join("\n")
    )

    const { value } = await this.ai.generateObject({
      model: config.modelId,
      schema: boundaryNamingResponseSchema,
      messages: [
        { role: "system", content: BOUNDARY_NAMING_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: config.temperature,
      telemetry: { functionId: "boundary-naming", metadata: { streamType: context.streamType } },
      context: { workspaceId: context.workspaceId, origin: "system" },
    })

    return value
  }

  private renderMessages(context: ExtractionContext, messages: Message[]): string {
    const now = context.newMessage.createdAt
    return messages
      .map((m) => `(${formatRelativeAge(m.createdAt, now)}) ${this.author(m)}: ${m.contentMarkdown.slice(0, 300)}`)
      .join("\n")
  }

  /**
   * The facts every question is asked against. Keys are addressed by the
   * instructions in `config.ts`, so renaming one is a prompt change.
   */
  private buildState(context: ExtractionContext, candidates: ConversationSummary[]) {
    const now = context.newMessage.createdAt
    const parentIds = new Set((context.parentMessageConversations ?? []).map((c) => c.id))
    const placed = this.placedMessages(context, candidates)

    return {
      streamType: context.streamType,
      conversations: candidates.map((c) => ({
        id: c.id,
        title: c.topicSummary,
        summary: c.summary,
        status: c.status,
        completeness: `${c.completenessScore}/7`,
        messageCount: c.messageCount,
        participantCount: c.participantIds.length,
        lastActive: formatRelativeAge(c.lastActivityAt, now),
        isParentThread: parentIds.has(c.id) || undefined,
      })),
      recentMessages: context.recentMessages
        .filter((m) => m.id !== context.newMessage.id)
        .map((m) => ({
          id: m.id,
          age: formatRelativeAge(m.createdAt, now),
          author: this.author(m),
          conversationId: placed.get(m.id) ?? null,
          text: m.contentMarkdown.slice(0, 200),
          attachments: this.attachments(context, m.id, RECENT_ATTACHMENT_CHARS),
          links: this.links(context, m.id),
        })),
      newMessage: {
        id: context.newMessage.id,
        author: this.author(context.newMessage),
        text: context.newMessage.contentMarkdown,
        attachments: this.attachments(context, context.newMessage.id, NEW_MESSAGE_ATTACHMENT_CHARS),
        links: this.links(context, context.newMessage.id),
      },
      replyTargets: (context.replyTargets ?? []).map((t) => ({
        quotedMessageId: t.quotedMessageId,
        conversationId: t.conversationId,
        quotedText: t.snippet,
      })),
    }
  }

  private buildQuestions(
    context: ExtractionContext,
    candidates: ConversationSummary[]
  ): Record<string, DecisionQuestion> {
    const questions: Record<string, DecisionQuestion> = {
      [KEY.placement]: {
        type: "choice",
        instructions: PLACEMENT_INSTRUCTIONS,
        criteria: {
          ...Object.fromEntries(candidates.map((c) => [c.id, this.placementCriterion(c)])),
          [NEW_CONVERSATION_CHOICE]:
            "None of the listed conversations. The message opens a topic they are not about, or arrives after a session gap without picking one of them back up.",
        },
      },
    }

    for (const c of candidates) {
      questions[KEY.secondary(c.id)] = { type: "noul", instructions: this.about(c, SECONDARY_INSTRUCTIONS) }
      questions[KEY.summaryStale(c.id)] = { type: "noul", instructions: this.about(c, SUMMARY_STALE_INSTRUCTIONS) }
      questions[KEY.completeness(c.id)] = {
        type: "score",
        instructions: this.about(c, COMPLETENESS_INSTRUCTIONS),
        criteria: [...COMPLETENESS_LADDER],
      }
      questions[KEY.status(c.id)] = {
        type: "choice",
        instructions: this.about(c, STATUS_INSTRUCTIONS),
        criteria: STATUS_CRITERIA,
      }
    }

    for (const messageId of this.placedMessages(context, candidates).keys()) {
      questions[KEY.move(messageId)] = {
        type: "noul",
        instructions: `${REASSIGNMENT_INSTRUCTIONS}\n\nThe earlier message is the entry in \`recentMessages\` with id "${messageId}".`,
      }
    }

    return questions
  }

  /** Scopes a per-conversation question to its subject; each question is answered in isolation. */
  private about(conversation: ConversationSummary, instructions: string): string {
    return `${instructions}\n\nThe conversation is the entry in \`conversations\` with id "${conversation.id}".`
  }

  private placementCriterion(conversation: ConversationSummary): string {
    const title = conversation.topicSummary ?? "no title yet"
    const covers = conversation.summary ? ` Covers: ${conversation.summary}` : ""
    return `"${title}".${covers} Its entry in \`conversations\` carries its status, age and message count.`
  }

  private author(message: Message): string {
    return `${message.authorType}:${message.authorId.slice(-8)}`
  }

  private attachments(context: ExtractionContext, messageId: string, maxChars: number) {
    const attachments: AttachmentExtractContext[] = context.attachmentsByMessageId?.get(messageId) ?? []
    if (attachments.length === 0) return undefined
    return attachments.map((a) => {
      const body = (a.fullText ?? a.summary ?? "").trim()
      return {
        filename: a.filename,
        kind: a.contentType ?? a.mimeType,
        text: body.length > maxChars ? body.slice(0, maxChars) + "…" : body,
      }
    })
  }

  private links(context: ExtractionContext, messageId: string): string | undefined {
    return renderLinkPreviewContext(context.linkPreviewsByMessageId?.get(messageId) ?? []) || undefined
  }
}
