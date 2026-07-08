import type { Pool, PoolClient } from "pg"
import { sql, withTransaction, withClient } from "../../db"
import { ConversationRepository, type Conversation } from "./repository"
import { MessageRepository, type Message } from "../messaging"
import { StreamRepository, type Stream } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository, awaitAttachmentProcessing, type AttachmentWithExtraction } from "../attachments"
import type {
  AttachmentExtractContext,
  BoundaryExtractor,
  ExtractionContext,
  ConversationSummary,
  CompletenessUpdate,
  MessageAssignment,
  Reassignment,
  ReplyTarget,
  SplitProposal,
} from "./boundary-extraction/types"
import { HttpError } from "../../lib/errors"
import { collectQuoteReplyMessageIds } from "@threa/prosemirror"
import { addStalenessFields } from "./staleness"
import { resolveConversationDelivery } from "./conversation-delivery"
import { emitAssignmentEvents } from "./assignment-events"
import { conversationId } from "../../lib/id"
import { AuthorTypes, ConversationStatuses, StreamTypes } from "@threa/types"
import { logger } from "../../lib/logger"

const MESSAGES_BEFORE = 5
const MESSAGES_AFTER = 2

interface ConversationDecision {
  assignments: MessageAssignment[]
  newTopic?: string
  newSummary?: string
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
   * On-demand, read-only: ask the clustering model how an existing conversation
   * should be split into smaller topics. Loads the conversation's messages,
   * runs {@link BoundaryExtractor.splitConversation}, and returns the proposal —
   * NO writes. The caller renders it for confirmation, then applies the confirmed
   * groups via {@link ConversationService.applySplit}. A single returned group
   * means the model judged the conversation focused (no split suggested).
   */
  async proposeSplit(conversationId: string, workspaceId: string): Promise<SplitProposal & { conversationId: string }> {
    const { conversation, stream, messages } = await withClient(this.pool, async (client) => {
      const conversation = await ConversationRepository.findById(client, conversationId)
      if (!conversation || conversation.workspaceId !== workspaceId) {
        return { conversation: null, stream: null, messages: [] as Message[] }
      }
      const stream = await StreamRepository.findById(client, conversation.streamId)
      const messagesMap = await MessageRepository.findByIds(client, conversation.messageIds)
      // Preserve the conversation's stored (chronological) order.
      const messages = conversation.messageIds
        .map((id) => messagesMap.get(id))
        .filter((m): m is Message => m !== undefined)
      return { conversation, stream, messages }
    })

    if (!conversation || !stream) {
      throw new HttpError("Conversation not found", { status: 404, code: "CONVERSATION_NOT_FOUND" })
    }

    const proposal = await this.extractor.splitConversation({
      conversationId: conversation.id,
      topicSummary: conversation.topicSummary,
      summary: conversation.summary,
      messages,
      streamType: stream.type,
      workspaceId,
    })

    logger.info(
      { conversationId: conversation.id, groupCount: proposal.groups.length, messageCount: messages.length },
      "Conversation split proposed"
    )
    return { conversationId: conversation.id, ...proposal }
  }

  /**
   * Three-phase pattern (INV-41) so the AI call holds no DB connection:
   *   Phase 1: fetch all context (withClient)
   *   Phase 2: AI extraction (no connection held)
   *   Phase 3: persist assignments + reassignments + completeness updates in one
   *            transaction; emit outbox events.
   *
   * Scratchpads take no AI call: the message joins the active conversation if one
   * exists, otherwise creates a new one.
   */
  async processMessage(messageId: string, streamId: string, workspaceId: string): Promise<Conversation | null> {
    // Phase 1: fetch context; collect new-message attachment IDs so their
    // processing can be awaited after the connection is released (INV-41), then
    // fetch extractions on the pool — mirrors streams/naming-service.ts.
    const fetchedData = await withClient(this.pool, async (client) => {
      const message = await MessageRepository.findById(client, messageId)
      if (!message) {
        return { message: null, stream: null, extractionContextBase: null }
      }

      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { message: null, stream: null, extractionContextBase: null }
      }

      // A message that DECLARED its conversation was assigned synchronously in
      // the send transaction. The message:created outbox still fires, but the
      // async pass must never re-cluster or move a human-declared assignment
      // (INV-20) — short-circuit with the conversation it already owns.
      if (message.conversationIntent !== null) {
        const declaredPrimary = await ConversationRepository.findPrimaryByMessageId(client, workspaceId, message.id)
        return {
          message,
          stream,
          extractionContextBase: null,
          declaredSkip: true,
          declaredPrimary,
          validUpdateTargets: new Set<string>(),
        }
      }

      // Agent replies (persona/bot) belong to a conversation too — invoking or
      // DMing an agent is conversing with it. They're assigned deterministically
      // (the stream's active conversation, created if none), NOT LLM-clustered:
      // a reply continues the conversation it's posted within. Handled after the
      // connection is released so the assignment runs in its own transaction.
      if (message.authorType !== AuthorTypes.USER) {
        return {
          message,
          stream,
          extractionContextBase: null,
          agentReply: true,
          validUpdateTargets: new Set<string>(),
        }
      }

      if (stream.type === StreamTypes.SCRATCHPAD) {
        const existingConversations = await ConversationRepository.findByStream(client, stream.id)
        return {
          message,
          stream,
          extractionContextBase: null,
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

      const relevantConversations = await ConversationRepository.findByMessageIds(
        client,
        workspaceId,
        allContextMessageIds
      )

      // Resolve explicit quote-replies to a strong continuity signal (INV-54:
      // structural attrs, not markdown heuristics). A quote-reply is a
      // deliberate user action, so the conversation that owns the quoted message
      // must be a candidate even when it scrolled out of the surrounding-message
      // window — otherwise the model can't assign to it. Scoped to this stream:
      // conversations are per-stream, so a quote into another stream has no valid
      // target here and is dropped.
      const { replyTargets, quotedConversations } = await this.resolveReplyTargets(
        client,
        workspaceId,
        stream.id,
        message
      )
      const candidateConversations = mergeConversationsById(relevantConversations, quotedConversations)

      let parentMessageConversations: Conversation[] = []
      if (stream.type === StreamTypes.THREAD && stream.parentMessageId) {
        parentMessageConversations = await ConversationRepository.findByMessageId(
          client,
          workspaceId,
          stream.parentMessageId
        )
      }

      const contextMessageIdSet = new Set(allContextMessageIds)
      const activeConversations = this.buildConversationSummaries(
        candidateConversations,
        allContextMessages,
        contextMessageIdSet
      )
      const parentConversations =
        parentMessageConversations.length > 0
          ? this.buildConversationSummaries(parentMessageConversations, [], contextMessageIdSet)
          : undefined

      // Await only new-message attachments: they're the payload most likely to
      // change classification. Context attachments were processed by their own
      // earlier boundary-extract runs.
      const newMessageAttachments = await AttachmentRepository.findByMessageId(client, message.id)
      const newMessageAttachmentIds = newMessageAttachments.map((a) => a.id)

      const extractionContextBase: Omit<ExtractionContext, "attachmentsByMessageId"> = {
        newMessage: message,
        recentMessages: allContextMessages,
        activeConversations,
        streamType: stream.type,
        parentMessageConversations: parentConversations,
        replyTargets: replyTargets.length > 0 ? replyTargets : undefined,
        workspaceId: stream.workspaceId,
      }

      const validUpdateTargets = new Set<string>([
        ...candidateConversations.map((c) => c.id),
        ...parentMessageConversations.map((c) => c.id),
      ])

      return {
        message,
        stream,
        extractionContextBase,
        newMessageAttachmentIds,
        attachmentTargetIds: [message.id, ...allContextMessageIds],
        validUpdateTargets,
        validReassignmentMessageIds: new Set(allContextMessageIds),
      }
    })

    if (!fetchedData.message || !fetchedData.stream) {
      logger.warn({ messageId, streamId }, "Message or stream not found for boundary extraction")
      return null
    }

    if (fetchedData.declaredSkip) {
      logger.debug({ messageId, streamId }, "Skipping boundary extraction for a message with a declared conversation")
      return fetchedData.declaredPrimary ?? null
    }

    if (fetchedData.agentReply) {
      return this.assignAgentReply(fetchedData.message, fetchedData.stream, workspaceId)
    }

    const {
      message,
      stream,
      extractionContextBase,
      newMessageAttachmentIds,
      attachmentTargetIds,
      scratchpadConversations,
      validUpdateTargets,
      validReassignmentMessageIds,
    } = fetchedData

    // Phase 1.5 (channels/threads only): await attachment processing with no DB
    // connection held (INV-41), then fetch extractions on the pool (INV-30).
    let extractionContext: ExtractionContext | null = null
    if (extractionContextBase && attachmentTargetIds) {
      if (newMessageAttachmentIds && newMessageAttachmentIds.length > 0) {
        logger.debug(
          { messageId, attachmentCount: newMessageAttachmentIds.length },
          "Boundary extraction awaiting attachment processing for new message"
        )
        const awaitResult = await awaitAttachmentProcessing(this.pool, newMessageAttachmentIds)
        if (!awaitResult.allCompleted) {
          // Classify with whatever extractions exist; don't block forever.
          logger.warn(
            {
              messageId,
              completedCount: awaitResult.completedIds.length,
              failedCount: awaitResult.failedOrTimedOutIds.length,
            },
            "Boundary extraction proceeding without all attachments processed"
          )
        }
      }

      const attachmentsByMessage = await AttachmentRepository.findByMessageIdsWithExtractions(
        this.pool,
        attachmentTargetIds
      )
      const attachmentsByMessageId = buildAttachmentContextMap(attachmentsByMessage, message.id)

      extractionContext = { ...extractionContextBase, attachmentsByMessageId }
    }

    // Phase 2: determine conversation (AI call only for channels/threads).
    let decision: ConversationDecision

    if (stream.type === StreamTypes.SCRATCHPAD) {
      // Scratchpad = one conversation, by decision (board-view-design.md). The
      // staleness sweep may have faded it to stalled/resolved, so fall back to
      // the most-recently-active conversation and let the assignment
      // reactivation flip it — never mint a second same-named conversation.
      const existingConversation =
        scratchpadConversations?.find((c) => c.status === ConversationStatuses.ACTIVE) ?? scratchpadConversations?.[0]
      decision = existingConversation
        ? {
            assignments: [{ conversationId: existingConversation.id, isPrimary: true }],
            confidence: 1.0,
            reassignments: [],
            validUpdateTargets: new Set([existingConversation.id]),
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

      // INV-11 fail-loudly invariant: validateResult guarantees ≥1 assignment with
      // exactly one primary. If that contract is broken upstream we want a hard
      // error here, not a silent transaction that orphans the new message.
      const primaryCount = result.assignments.filter((a) => a.isPrimary).length
      if (result.assignments.length === 0 || primaryCount !== 1) {
        throw new Error(
          `Extractor produced invalid assignments (count=${result.assignments.length}, primary=${primaryCount}) for message ${messageId}`
        )
      }

      decision = {
        assignments: result.assignments,
        newTopic: result.newConversationTopic,
        newSummary: result.newConversationSummary,
        confidence: result.confidence,
        reassignments: result.reassignments ?? [],
        completenessUpdates: result.completenessUpdates,
        validUpdateTargets,
      }
    }

    // Phase 3: persist everything in one transaction.
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
              summary: decision.newSummary,
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

      const touchedConversationIds = new Set<string>()
      const reassignmentEvents: {
        messageId: string
        // The stream where the reassigned message actually lives. May differ from
        // the new message's `streamId` when a context-window message originated in
        // another stream — the outbox event must route to that stream's room, not
        // the new message's stream.
        streamId: string
        fromConversationId: string
        toConversationId: string
        reason: string
      }[] = []

      // Apply reassignments first so the LLM-flagged messages have already moved
      // out of their old conversation before we write the new message — that
      // way `message_ids` is never transiently doubled when the same message
      // appears in two conversations.
      const reassignmentMessageIds = validReassignmentMessageIds ?? new Set<string>()
      const candidateReassignments = decision.reassignments.filter((r) => reassignmentMessageIds.has(r.messageId))
      const skippedOutOfWindow = decision.reassignments.length - candidateReassignments.length
      if (skippedOutOfWindow > 0) {
        logger.warn(
          { skipped: skippedOutOfWindow, streamId },
          "Dropped reassignments targeting messages outside the extraction window"
        )
      }

      // INV-20 race safety: lock the message rows we're about to (re)assign so
      // two concurrent boundary extractions can't both write the same message
      // into two different conversations. Scoping is intentionally on id only
      // — `messages.id` is the PK, and the id set comes from
      // validReassignmentMessageIds (already filtered against the messages we
      // just queried in this stream and its threads), so there's no
      // cross-tenant exposure to guard against here.
      const lockMessageIds = [messageId, ...candidateReassignments.map((r) => r.messageId)]
      await client.query(sql`
        SELECT id FROM messages
        WHERE id = ANY(${lockMessageIds}::text[])
        FOR UPDATE
      `)

      const existingPrimariesByMessageId = await ConversationRepository.findPrimariesByMessageIds(
        client,
        workspaceId,
        candidateReassignments.map((r) => r.messageId)
      )

      const messagesById = new Map<string, Message>([[message.id, message]])

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
        if (existingPrimary.id === toConvId) {
          continue
        }

        const fromConvId = existingPrimary.id

        let reassignedMessage = messagesById.get(r.messageId)
        if (!reassignedMessage) {
          const m = await MessageRepository.findById(client, r.messageId)
          if (m) {
            reassignedMessage = m
            messagesById.set(r.messageId, m)
          }
        }

        // A message with a declared conversation is human-assigned: the async
        // pass never moves it out of the conversation it was placed in (INV-20).
        if (reassignedMessage?.conversationIntent != null) {
          logger.warn({ messageId: r.messageId }, "Skipping reassignment of a message with a declared conversation")
          continue
        }

        await ConversationRepository.removePrimaryMessage(client, workspaceId, fromConvId, r.messageId)
        await ConversationRepository.addPrimaryMessage(
          client,
          workspaceId,
          toConvId,
          r.messageId,
          reassignedMessage?.authorId ?? null
        )

        touchedConversationIds.add(fromConvId)
        touchedConversationIds.add(toConvId)
        reassignmentEvents.push({
          messageId: r.messageId,
          streamId: reassignedMessage?.streamId ?? existingPrimary.streamId,
          fromConversationId: fromConvId,
          toConversationId: toConvId,
          reason: r.reason,
        })
      }

      for (const a of resolvedAssignments) {
        if (a.isPrimary) {
          await ConversationRepository.addPrimaryMessage(
            client,
            workspaceId,
            a.conversationId,
            messageId,
            message.authorId
          )
          // A stalled/resolved conversation gaining a message is live again
          // (sweep fades must not stick to conversations that resume). Runs
          // before completenessUpdates, so an explicit resolve in the same
          // pass still wins.
          await ConversationRepository.reactivateIfInactive(client, workspaceId, a.conversationId)
        } else {
          await ConversationRepository.addSecondaryMessage(client, workspaceId, a.conversationId, messageId)
        }
        touchedConversationIds.add(a.conversationId)
      }

      if (decision.completenessUpdates) {
        for (const update of decision.completenessUpdates) {
          if (!decision.validUpdateTargets.has(update.conversationId)) {
            logger.warn(
              { conversationId: update.conversationId, streamId },
              "LLM attempted to update conversation not in active set - skipping"
            )
            continue
          }

          // Refine completeness freely, but never override a status the user set
          // (Mark resolved / Reopen) — user intent wins over the LLM (guarded in SQL).
          await ConversationRepository.applyExtractionUpdate(client, workspaceId, update.conversationId, {
            completenessScore: update.score,
            status: update.status,
            summary: update.summary,
          })
          touchedConversationIds.add(update.conversationId)
        }
      }

      // Bump last_activity_at on every touched conversation so sort position and
      // staleness reflect the activity; assignments/reassignments don't bump it.
      const touchedIds = Array.from(touchedConversationIds)
      await ConversationRepository.bumpActivityForIds(client, workspaceId, touchedIds)

      // Parent channel (thread discoverability) + access-root visibility (INV-62)
      // for the new message's stream — used by its per-message events below.
      const { parentStreamId } = await resolveConversationDelivery(client, stream)

      // A touched conversation can live in a DIFFERENT stream than the triggering
      // one (a reassigned context-window message from another channel), so each
      // aggregate event must route by its OWN access root — using the triggering
      // stream's visibility would broadcast a private conversation to the whole
      // workspace (INV-62). Resolve per stream, memoized for the common case.
      const deliveryByStreamId = new Map<string, Awaited<ReturnType<typeof resolveConversationDelivery>>>()
      const deliveryFor = async (conversationStreamId: string) => {
        const cached = deliveryByStreamId.get(conversationStreamId)
        if (cached) return cached
        const conversationStream =
          conversationStreamId === stream.id ? stream : await StreamRepository.findById(client, conversationStreamId)
        const resolved = await resolveConversationDelivery(client, conversationStream)
        deliveryByStreamId.set(conversationStreamId, resolved)
        return resolved
      }

      const primaryAssignment = resolvedAssignments.find((a) => a.isPrimary)
      const primaryConvId = primaryAssignment?.conversationId ?? null

      const touchedConversations = await ConversationRepository.findByIds(client, workspaceId, touchedIds)
      for (const conv of touchedConversations) {
        const isNewThisCall = newConversation?.id === conv.id
        const eventType = isNewThisCall ? "conversation:created" : "conversation:updated"
        const { parentStreamId: convParentStreamId, streamVisibility } = await deliveryFor(conv.streamId)
        await OutboxRepository.insert(client, eventType, {
          workspaceId,
          streamId: conv.streamId,
          conversationId: conv.id,
          conversation: addStalenessFields(conv),
          parentStreamId: convParentStreamId,
          streamVisibility,
        })
      }

      // Emit per-assignment events for the new message (so the frontend knows
      // which conv(s) the new message belongs to). `parentStreamId` mirrors the
      // conversation:* events above so parent-channel subscribers receive the
      // membership update for thread messages too.
      for (const a of resolvedAssignments) {
        await OutboxRepository.insert(client, "conversation:message_assigned", {
          workspaceId,
          streamId,
          parentStreamId,
          messageId,
          conversationId: a.conversationId,
          isPrimary: a.isPrimary,
          reason: a.isPrimary ? "initial" : "secondary",
        })
      }

      // Emit per-reassignment events. The reassigned message may live in a
      // different stream than the new message that triggered this extraction
      // (e.g. a context-window message from another channel), so the event is
      // routed to that stream — `ev.streamId` — not the outer `streamId`.
      for (const ev of reassignmentEvents) {
        await OutboxRepository.insert(client, "conversation:message_reassigned", {
          workspaceId,
          streamId: ev.streamId,
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

  /**
   * Assign a non-user (agent) reply to a conversation deterministically — no LLM.
   * An agent reply continues the conversation it's posted within, so it joins the
   * stream's most-recently-active conversation; if the stream has none yet (a
   * fresh thread the agent created for a channel @mention), it mints one, which
   * the board renders under the triggering message. Mirrors the extractor's
   * persist phase: the message row is locked before assignment (INV-20) and the
   * membership write, activity bump, and outbox events commit together (INV-4/7).
   */
  private async assignAgentReply(message: Message, stream: Stream, workspaceId: string): Promise<Conversation | null> {
    return withTransaction(this.pool, async (client) => {
      // Lock the message row so a concurrent re-delivery can't double-assign.
      await client.query(sql`SELECT id FROM messages WHERE id = ${message.id} FOR UPDATE`)

      // Idempotent on re-delivery: if already a primary somewhere, leave it.
      const existingPrimary = await ConversationRepository.findPrimaryByMessageId(client, workspaceId, message.id)
      if (existingPrimary) return existingPrimary

      // Lock the stream so two replies racing in a fresh thread don't both mint a
      // conversation (mirrors the scratchpad create path's stream lock, INV-20).
      await client.query(sql`SELECT id FROM streams WHERE id = ${stream.id} FOR UPDATE`)

      // Scratchpads keep one conversation for the stream's lifetime, so a
      // sweep-faded conversation is reused (and reactivated below) rather than
      // shadowed by a fresh mint; elsewhere a fully-faded stream means a new
      // session and a new conversation is correct.
      const existing =
        (await ConversationRepository.findActiveByStream(client, stream.id))[0] ??
        (stream.type === StreamTypes.SCRATCHPAD
          ? (await ConversationRepository.findByStream(client, stream.id, { limit: 1 }))[0]
          : undefined)
      const isNew = !existing
      const conversation =
        existing ??
        (await ConversationRepository.insert(client, {
          id: conversationId(),
          streamId: stream.id,
          workspaceId,
          confidence: 1,
          status: ConversationStatuses.ACTIVE,
        }))

      await ConversationRepository.addPrimaryMessage(client, workspaceId, conversation.id, message.id, message.authorId)
      await ConversationRepository.reactivateIfInactive(client, workspaceId, conversation.id)
      await ConversationRepository.bumpActivityForIds(client, workspaceId, [conversation.id])

      // Same per-message membership emit the declared-send path uses (INV-35/37);
      // it re-reads the conversation and routes a thread's parent-channel fan-out.
      const refreshed = await emitAssignmentEvents(client, {
        workspaceId,
        message,
        conversationId: conversation.id,
        created: isNew,
        reason: "agent_reply",
      })

      logger.info(
        { messageId: message.id, streamId: stream.id, conversationId: refreshed.id, created: isNew },
        "Agent reply assigned to conversation"
      )
      return refreshed
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
        summary: c.summary,
        messageCount: c.messageIds.length,
        lastMessagePreview: lastMessage?.contentMarkdown.slice(0, 100) ?? "",
        participantIds: c.participantIds,
        completenessScore: c.completenessScore,
        status: c.status,
        lastActivityAt: c.lastActivityAt,
        contextMessageIds: contextIds,
      }
    })
  }

  private async resolveReplyTargets(
    client: PoolClient,
    workspaceId: string,
    streamId: string,
    message: Message
  ): Promise<{ replyTargets: ReplyTarget[]; quotedConversations: Conversation[] }> {
    const quotedMessageIds = collectQuoteReplyMessageIds(message.contentJson)
    if (quotedMessageIds.length === 0) return { replyTargets: [], quotedConversations: [] }

    const quotedMessages = await MessageRepository.findByIdsInStreams(client, workspaceId, quotedMessageIds, [streamId])
    if (quotedMessages.size === 0) return { replyTargets: [], quotedConversations: [] }

    const primariesByMessageId = await ConversationRepository.findPrimariesByMessageIds(client, workspaceId, [
      ...quotedMessages.keys(),
    ])

    const replyTargets: ReplyTarget[] = []
    const quotedConversations: Conversation[] = []
    for (const quotedMessageId of quotedMessageIds) {
      const quotedMessage = quotedMessages.get(quotedMessageId)
      if (!quotedMessage) continue
      const conv = primariesByMessageId.get(quotedMessageId)
      if (!conv) continue
      replyTargets.push({
        quotedMessageId,
        conversationId: conv.id,
        topicSummary: conv.topicSummary,
        snippet: quotedMessage.contentMarkdown.slice(0, 100),
      })
      quotedConversations.push(conv)
    }
    return { replyTargets, quotedConversations }
  }
}

/** Append `extra` conversations not already present in `primary`, deduped by id. */
function mergeConversationsById(primary: Conversation[], extra: Conversation[]): Conversation[] {
  if (extra.length === 0) return primary
  const byId = new Map<string, Conversation>(primary.map((c) => [c.id, c]))
  for (const c of extra) {
    if (!byId.has(c.id)) byId.set(c.id, c)
  }
  return [...byId.values()]
}

/**
 * Build the per-message attachment-context map used by the LLM prompt. Only
 * the new message keeps its full extracted text; context messages drop
 * `fullText` (the prompt renderer falls back to `summary`, keeping the prompt
 * bounded). Attachments with neither a summary nor fullText are dropped so the
 * prompt does not get cluttered with empty entries.
 */
function buildAttachmentContextMap(
  attachmentsByMessage: Map<string, AttachmentWithExtraction[]>,
  newMessageId: string
): Map<string, AttachmentExtractContext[]> {
  const result = new Map<string, AttachmentExtractContext[]>()
  for (const [msgId, attachments] of attachmentsByMessage) {
    const contexts: AttachmentExtractContext[] = []
    for (const a of attachments) {
      const isNewMessage = msgId === newMessageId
      const summary = a.extraction?.summary ?? null
      const fullText = isNewMessage ? (a.extraction?.fullText ?? null) : null
      // Drop attachments with no extracted text at all (e.g. still pending or
      // a type that produces no extraction) — there is nothing useful to add.
      if (!summary && !fullText) continue
      contexts.push({
        filename: a.filename,
        mimeType: a.mimeType,
        contentType: a.extraction?.contentType ?? null,
        summary,
        fullText,
      })
    }
    if (contexts.length > 0) result.set(msgId, contexts)
  }
  return result
}

export type { PoolClient }
