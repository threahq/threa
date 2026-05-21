import type { Pool, PoolClient } from "pg"
import { sql, withTransaction, withClient } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { ConversationMessageAssignmentRepository, type AssignmentReason } from "./assignment-repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import type {
  BoundaryExtractor,
  ExtractionContext,
  ConversationSummary,
  CompletenessUpdate,
  MessageAssignment,
  Reassignment,
} from "./boundary-extraction/types"
import { addStalenessFields } from "./staleness"
import { conversationId } from "../../lib/id"
import { ConversationStatuses, StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"

const MESSAGES_BEFORE = 5
const MESSAGES_AFTER = 2

interface ConversationDecision {
  assignments: MessageAssignment[]
  newTopic?: string
  confidence: number
  reassignments: Reassignment[]
  completenessUpdates?: CompletenessUpdate[]
  /** IDs of conversations that are valid targets for completeness updates / reassignment (security). */
  validUpdateTargets: Set<string>
}

export class BoundaryExtractionService {
  constructor(
    private pool: Pool,
    private extractor: BoundaryExtractor
  ) {}

  /**
   * Process a message for boundary extraction.
   *
   * Three-phase pattern (INV-41) so the AI call holds no DB connection:
   *   Phase 1: fetch all context (withClient, ~100-200ms)
   *   Phase 2: AI extraction (no connection held, 1-5+ seconds for channels/threads)
   *   Phase 3: persist all assignments + reassignments + completeness updates in one
   *            transaction; emit outbox events.
   *
   * For scratchpads: no AI call. The message joins the active conversation if one
   * exists, otherwise creates a new one.
   *
   * For channels/threads: the extractor returns multi-assignment + reassignment
   * decisions in a single call. Threads no longer take a deterministic shortcut —
   * the LLM sees the parent message's conversation alongside the thread's active
   * conversation and decides.
   */
  async processMessage(messageId: string, streamId: string, workspaceId: string): Promise<Conversation | null> {
    // Phase 1: Fetch all data with withClient (no transaction, fast reads ~100-200ms)
    const fetchedData = await withClient(this.pool, async (client) => {
      const message = await MessageRepository.findById(client, messageId)
      if (!message) {
        return { message: null, stream: null, extractionContext: null }
      }

      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { message: null, stream: null, extractionContext: null }
      }

      // For scratchpads: just fetch existing conversations (no AI needed)
      if (stream.type === StreamTypes.SCRATCHPAD) {
        const existingConversations = await ConversationRepository.findByStream(client, stream.id)
        return {
          message,
          stream,
          extractionContext: null,
          scratchpadConversations: existingConversations,
          validUpdateTargets: new Set<string>(),
        }
      }

      const surroundingMessages = await MessageRepository.findSurrounding(
        client,
        message.id,
        stream.id,
        MESSAGES_BEFORE,
        MESSAGES_AFTER
      )

      const threadRootIds = surroundingMessages.filter((m) => m.replyCount > 0).map((m) => m.id)
      const threadMessagesByParent = await MessageRepository.findThreadMessages(client, threadRootIds)
      const allThreadMessages = Array.from(threadMessagesByParent.values()).flat()

      const allContextMessages = [...surroundingMessages, ...allThreadMessages]
      const allContextMessageIds = allContextMessages.map((m) => m.id)

      const relevantConversations = await ConversationRepository.findByMessageIds(client, allContextMessageIds)

      let parentMessageConversations: Conversation[] = []
      if (stream.type === StreamTypes.THREAD && stream.parentMessageId) {
        parentMessageConversations = await ConversationRepository.findByMessageId(client, stream.parentMessageId)
      }

      const contextMessageIdSet = new Set(allContextMessageIds)
      const activeConversations = this.buildConversationSummaries(
        relevantConversations,
        allContextMessages,
        contextMessageIdSet
      )
      const parentConversations =
        parentMessageConversations.length > 0
          ? this.buildConversationSummaries(parentMessageConversations, [], contextMessageIdSet)
          : undefined

      const extractionContext: ExtractionContext = {
        newMessage: message,
        recentMessages: allContextMessages,
        activeConversations,
        streamType: stream.type,
        parentMessageConversations: parentConversations,
        workspaceId: stream.workspaceId,
      }

      const validUpdateTargets = new Set<string>([
        ...relevantConversations.map((c) => c.id),
        ...parentMessageConversations.map((c) => c.id),
      ])

      return {
        message,
        stream,
        extractionContext,
        validUpdateTargets,
        validReassignmentMessageIds: new Set(allContextMessageIds),
      }
    })

    if (!fetchedData.message || !fetchedData.stream) {
      logger.warn({ messageId, streamId }, "Message or stream not found for boundary extraction")
      return null
    }

    const {
      message,
      stream,
      extractionContext,
      scratchpadConversations,
      validUpdateTargets,
      validReassignmentMessageIds,
    } = fetchedData

    // Phase 2: Determine conversation (AI call only for channels/threads, 1-5+ seconds!)
    let decision: ConversationDecision

    if (stream.type === StreamTypes.SCRATCHPAD) {
      const activeConversation = scratchpadConversations?.find((c) => c.status === ConversationStatuses.ACTIVE)
      decision = activeConversation
        ? {
            assignments: [{ conversationId: activeConversation.id, isPrimary: true }],
            confidence: 1.0,
            reassignments: [],
            validUpdateTargets: new Set([activeConversation.id]),
          }
        : {
            assignments: [{ conversationId: null, isPrimary: true }],
            newTopic: stream.displayName ?? "Scratchpad",
            confidence: 1.0,
            reassignments: [],
            validUpdateTargets: new Set(),
          }
    } else {
      if (!extractionContext) {
        logger.error({ messageId, streamId }, "Missing extraction context for channel/thread")
        return null
      }

      const result = await this.extractor.extract(extractionContext)
      decision = {
        assignments: result.assignments,
        newTopic: result.newConversationTopic,
        confidence: result.confidence,
        reassignments: result.reassignments ?? [],
        completenessUpdates: result.completenessUpdates,
        validUpdateTargets,
      }
    }

    // Phase 3: Save result in ONE transaction (fast, ~100ms)
    return withTransaction(this.pool, async (client) => {
      // For scratchpads: race-safe re-check that the active conversation still
      // exists / doesn't exist (another process may have created it).
      if (
        stream.type === StreamTypes.SCRATCHPAD &&
        decision.assignments.length === 1 &&
        decision.assignments[0].conversationId === null
      ) {
        await client.query(sql`SELECT id FROM streams WHERE id = ${stream.id} FOR UPDATE`)

        const existingConversations = await ConversationRepository.findByStream(client, stream.id)
        const activeConversation = existingConversations.find((c) => c.status === ConversationStatuses.ACTIVE)

        if (activeConversation) {
          decision.assignments = [{ conversationId: activeConversation.id, isPrimary: true }]
          decision.newTopic = undefined
          decision.validUpdateTargets.add(activeConversation.id)
        }
      }

      // Resolve any null assignments to a freshly created conversation.
      let newConversation: Conversation | null = null
      const resolvedAssignments: { conversationId: string; isPrimary: boolean }[] = []
      for (const a of decision.assignments) {
        if (a.conversationId === null) {
          if (!newConversation) {
            newConversation = await ConversationRepository.insert(client, {
              id: conversationId(),
              streamId,
              workspaceId,
              topicSummary: decision.newTopic,
              confidence: decision.confidence,
              status: ConversationStatuses.ACTIVE,
            })
            decision.validUpdateTargets.add(newConversation.id)
          }
          resolvedAssignments.push({ conversationId: newConversation.id, isPrimary: a.isPrimary })
        } else {
          resolvedAssignments.push({ conversationId: a.conversationId, isPrimary: a.isPrimary })
        }
      }

      // Track which conversations were touched, for outbox event fan-out.
      const touchedConversationIds = new Set<string>()
      const reassignmentEvents: {
        messageId: string
        fromConversationId: string
        toConversationId: string
        reason: string
      }[] = []

      // Assign the new message.
      for (const a of resolvedAssignments) {
        if (a.isPrimary) {
          await ConversationMessageAssignmentRepository.assignPrimary(client, {
            conversationId: a.conversationId,
            messageId,
            streamId,
            workspaceId,
            reason: "initial",
            confidence: decision.confidence,
          })
        } else {
          await ConversationMessageAssignmentRepository.assignSecondary(client, {
            conversationId: a.conversationId,
            messageId,
            streamId,
            workspaceId,
            reason: "secondary",
            confidence: decision.confidence,
          })
        }
        touchedConversationIds.add(a.conversationId)
      }

      // Apply reassignments. The extractor is trusted to only target messages
      // it actually saw, but we defense-in-depth validate that `r.messageId`
      // was in Phase 1's surrounding/thread window and that `toConversationId`
      // is in `validUpdateTargets` (or null when a new conversation was created).
      const reassignmentMessageIds = validReassignmentMessageIds ?? new Set<string>()
      const candidateReassignments = decision.reassignments.filter((r) => reassignmentMessageIds.has(r.messageId))
      const skippedOutOfWindow = decision.reassignments.length - candidateReassignments.length
      if (skippedOutOfWindow > 0) {
        logger.warn(
          { skipped: skippedOutOfWindow, streamId },
          "Dropped reassignments targeting messages outside the extraction window"
        )
      }

      const existingPrimariesByMessageId = new Map(
        (
          await ConversationMessageAssignmentRepository.findPrimariesByMessageIds(
            client,
            candidateReassignments.map((r) => r.messageId)
          )
        ).map((p) => [p.messageId, p])
      )

      for (const r of candidateReassignments) {
        let toConvId: string
        if (r.toConversationId === null) {
          if (!newConversation) {
            logger.warn(
              { messageId: r.messageId },
              "Reassignment targets a new conversation but none was created - skipping"
            )
            continue
          }
          toConvId = newConversation.id
        } else if (decision.validUpdateTargets.has(r.toConversationId)) {
          toConvId = r.toConversationId
        } else {
          logger.warn(
            { conversationId: r.toConversationId, messageId: r.messageId },
            "Reassignment target not in valid update set - skipping"
          )
          continue
        }

        const existingPrimary = existingPrimariesByMessageId.get(r.messageId)
        if (!existingPrimary) {
          logger.warn({ messageId: r.messageId }, "Reassignment target message has no existing primary - skipping")
          continue
        }
        if (existingPrimary.conversationId === toConvId) {
          // No-op move; the LLM is asking us to move the message to where it already lives.
          continue
        }

        const fromConvId = existingPrimary.conversationId

        await ConversationMessageAssignmentRepository.assignPrimary(client, {
          conversationId: toConvId,
          messageId: r.messageId,
          streamId: existingPrimary.streamId,
          workspaceId,
          reason: "reassigned",
          confidence: r.confidence ?? decision.confidence,
        })

        touchedConversationIds.add(fromConvId)
        touchedConversationIds.add(toConvId)
        reassignmentEvents.push({
          messageId: r.messageId,
          fromConversationId: fromConvId,
          toConversationId: toConvId,
          reason: r.reason,
        })
      }

      // Apply completeness updates.
      if (decision.completenessUpdates) {
        for (const update of decision.completenessUpdates) {
          if (!decision.validUpdateTargets.has(update.conversationId)) {
            logger.warn(
              { conversationId: update.conversationId, streamId },
              "LLM attempted to update conversation not in active set - skipping"
            )
            continue
          }

          await ConversationRepository.update(client, update.conversationId, {
            completenessScore: update.score,
            status: update.status,
          })
          touchedConversationIds.add(update.conversationId)
        }
      }

      // Bump last_activity_at on every touched conversation so its sort position
      // and staleness reflect the activity (assignments/reassignments don't bump
      // it implicitly — that lived in the array UPDATE before).
      const touchedIds = Array.from(touchedConversationIds)
      await ConversationRepository.bumpActivityForIds(client, touchedIds)

      // For thread conversations, include parent channel's stream ID for discoverability.
      let parentStreamId: string | undefined
      if (stream.type === StreamTypes.THREAD && stream.parentMessageId) {
        const parentMessage = await MessageRepository.findById(client, stream.parentMessageId)
        parentStreamId = parentMessage?.streamId
      }

      // Emit outbox events for every touched conversation.
      // The conversation that received the new message as primary is reported
      // first (as conversation:created if it's new, conversation:updated otherwise).
      const primaryAssignment = resolvedAssignments.find((a) => a.isPrimary)
      const primaryConvId = primaryAssignment?.conversationId ?? null

      const touchedConversations = await ConversationRepository.findByIds(client, touchedIds)
      for (const conv of touchedConversations) {
        const isNewThisCall = newConversation?.id === conv.id
        const eventType = isNewThisCall ? "conversation:created" : "conversation:updated"
        await OutboxRepository.insert(client, eventType, {
          workspaceId,
          streamId: conv.streamId,
          conversationId: conv.id,
          conversation: addStalenessFields(conv),
          parentStreamId,
        })
      }

      // Emit per-assignment events for the new message (so the frontend knows
      // which conv(s) the new message belongs to).
      for (const a of resolvedAssignments) {
        await OutboxRepository.insert(client, "conversation:message_assigned", {
          workspaceId,
          streamId,
          messageId,
          conversationId: a.conversationId,
          isPrimary: a.isPrimary,
          reason: a.isPrimary ? "initial" : "secondary",
        })
      }

      // Emit per-reassignment events.
      for (const ev of reassignmentEvents) {
        await OutboxRepository.insert(client, "conversation:message_reassigned", {
          workspaceId,
          streamId,
          messageId: ev.messageId,
          fromConversationId: ev.fromConversationId,
          toConversationId: ev.toConversationId,
          reason: ev.reason,
        })
      }

      logger.info(
        {
          messageId,
          primaryConversationId: primaryConvId,
          assignmentCount: resolvedAssignments.length,
          reassignmentCount: reassignmentEvents.length,
          confidence: decision.confidence,
        },
        "Boundary extraction complete"
      )

      if (!primaryConvId) return null
      return touchedConversations.find((c) => c.id === primaryConvId) ?? null
    })
  }

  private buildConversationSummaries(
    conversations: Conversation[],
    contextMessages: Message[],
    contextMessageIds: Set<string>
  ): ConversationSummary[] {
    const messageMap = new Map(contextMessages.map((m) => [m.id, m]))

    return conversations.map((c) => {
      const lastMessageId = c.messageIds[c.messageIds.length - 1]
      const lastMessage = lastMessageId ? messageMap.get(lastMessageId) : undefined
      const contextIds = c.messageIds.filter((id) => contextMessageIds.has(id))

      return {
        id: c.id,
        topicSummary: c.topicSummary,
        messageCount: c.messageIds.length,
        lastMessagePreview: lastMessage?.contentMarkdown.slice(0, 100) ?? "",
        participantIds: c.participantIds,
        completenessScore: c.completenessScore,
        contextMessageIds: contextIds,
      }
    })
  }
}

// Re-export type for service consumers
export type { PoolClient }
