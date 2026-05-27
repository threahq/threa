import { Pool } from "pg"
import { withTransaction, withClient } from "../../db"
import { StreamRepository } from "./repository"
import { MessageRepository } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import { AttachmentRepository, type AttachmentWithExtraction } from "../attachments"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../lib/ai/config-resolver"
import { COMPONENT_PATHS } from "../../lib/ai/config-resolver"
import { needsAutoNaming } from "./display-name"
import { logger } from "../../lib/logger"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import { awaitAttachmentProcessing } from "../attachments"
import { MAX_MESSAGES_FOR_NAMING, MAX_EXISTING_NAMES, buildNamingSystemPrompt } from "./naming-config"

export interface GenerateNameResult {
  name: string | null
  notEnoughContext: boolean
}

export class StreamNamingService {
  constructor(
    private pool: Pool,
    private ai: AI,
    private configResolver: ConfigResolver,
    private messageFormatter: MessageFormatter
  ) {}

  /**
   * Generate a name for a conversation given formatted text.
   * This is the pure naming logic without database integration.
   * Used by attemptAutoNaming() and can be called directly for testing.
   *
   * @param conversationText Formatted conversation text
   * @param existingNames Names to avoid duplicating
   * @param requireName If true, NOT_ENOUGH_CONTEXT throws instead of returning null
   * @param context Optional context for cost tracking
   */
  async generateName(
    conversationText: string,
    existingNames: string[],
    requireName: boolean,
    context?: { workspaceId: string }
  ): Promise<GenerateNameResult> {
    const config = await this.configResolver.resolve(COMPONENT_PATHS.STREAM_NAMING)
    const systemPrompt = buildNamingSystemPrompt(existingNames, requireName)

    const { value } = await this.ai.generateText({
      model: config.modelId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: conversationText },
      ],
      temperature: config.temperature,
      telemetry: {
        functionId: "stream-naming",
        metadata: { requireName, existingNamesCount: existingNames.length },
      },
      context: context ? { workspaceId: context.workspaceId, origin: "system" } : undefined,
    })

    const rawName = value?.trim() || null

    if (!rawName || rawName === "NOT_ENOUGH_CONTEXT") {
      if (requireName) {
        throw new Error("Failed to generate required name: NOT_ENOUGH_CONTEXT returned")
      }
      return { name: null, notEnoughContext: true }
    }

    // Clean up the response (remove quotes, trim)
    const cleanName = rawName.replace(/^["']|["']$/g, "").trim()

    if (cleanName.length === 0 || cleanName.length > 100) {
      if (requireName) {
        throw new Error(`Failed to generate required name: invalid response "${rawName}"`)
      }
      return { name: null, notEnoughContext: false }
    }

    return { name: cleanName, notEnoughContext: false }
  }

  /**
   * Attempts to auto-generate a display name for a stream.
   * Called after each message is created in scratchpads/threads.
   *
   * IMPORTANT: This method uses the three-phase pattern (INV-41) to avoid holding
   * database connections during slow operations:
   *
   * Phase 1: Fetch all data (stream, messages, attachments, names) with withClient (~100-200ms)
   * Await: Poll for image processing completion with no connection held (0-60s)
   * Fetch extractions: Quick read of extraction data after processing completes (~50ms)
   * Phase 2: AI call with no database connection held (1-5+ seconds)
   * Phase 3: Save result with withTransaction, re-checking stream state (~100ms)
   *
   * The re-check in Phase 3 handles the race condition where another process
   * names the stream while we're generating. This wastes one AI call but prevents
   * pool exhaustion from holding connections during AI operations.
   *
   * @param requireName If true, must generate a name (throws if NOT_ENOUGH_CONTEXT).
   *                    Set to true for agent messages, false for user messages.
   * @returns true if a name was successfully generated and saved.
   */
  async attemptAutoNaming(streamId: string, requireName: boolean): Promise<boolean> {
    // Phase 1: Fetch all data with withClient (no transaction, fast reads ~100-200ms)
    const fetchedData = await withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { stream: null, messages: [], otherStreams: [], attachmentIds: [] }
      }

      if (!needsAutoNaming(stream)) {
        return { stream: null, messages: [], otherStreams: [], attachmentIds: [] }
      }

      // Fetch recent messages to build context
      const messages = await MessageRepository.list(client, streamId, {
        limit: MAX_MESSAGES_FOR_NAMING,
      })

      if (messages.length === 0) {
        return { stream: null, messages: [], otherStreams: [], attachmentIds: [] }
      }

      // Fetch existing stream names to avoid duplicates
      const otherStreams = await StreamRepository.list(client, stream.workspaceId, { types: [stream.type] })

      // Fetch attachments for these messages (to get IDs for awaiting processing)
      const messageIds = messages.map((m) => m.id)
      const attachmentsByMessage = await AttachmentRepository.findByMessageIds(client, messageIds)

      // Collect all attachment IDs
      const attachmentIds: string[] = []
      for (const attachments of attachmentsByMessage.values()) {
        for (const a of attachments) {
          attachmentIds.push(a.id)
        }
      }

      return { stream, messages, otherStreams, attachmentIds }
    })

    // Early exit if nothing to do
    if (!fetchedData.stream) {
      return false
    }

    const { stream, messages, otherStreams, attachmentIds } = fetchedData

    // Await attachment processing (no connection held - polling releases between checks)
    // This ensures attachment extractions are available before we format the conversation
    if (attachmentIds.length > 0) {
      logger.debug(
        { streamId, attachmentCount: attachmentIds.length },
        "Awaiting attachment processing for stream naming"
      )
      const awaitResult = await awaitAttachmentProcessing(this.pool, attachmentIds)
      logger.debug(
        {
          streamId,
          completedCount: awaitResult.completedIds.length,
          failedCount: awaitResult.failedOrTimedOutIds.length,
        },
        "Attachment processing complete for stream naming"
      )
    }

    // Fetch attachments with extractions (quick read, uses pool directly per INV-30)
    const messageIds = messages.map((m) => m.id)
    let attachmentsByMessageId: Map<string, AttachmentWithExtraction[]>
    if (attachmentIds.length > 0) {
      attachmentsByMessageId = await AttachmentRepository.findByMessageIdsWithExtractions(this.pool, messageIds)
    } else {
      attachmentsByMessageId = new Map()
    }

    // Format messages with attachment extractions (quick read for author names)
    const conversationText = await this.messageFormatter.formatMessagesWithAttachments(
      this.pool,
      stream.workspaceId,
      messages,
      attachmentsByMessageId
    )

    // Phase 2: AI processing (no connection held, 1-5+ seconds!)
    const existingNames = otherStreams
      .filter((s) => s.displayName && s.id !== streamId)
      .slice(0, MAX_EXISTING_NAMES)
      .map((s) => s.displayName!)

    // Call LLM via generateName() (1-5+ seconds, no DB connection held!)
    let result: GenerateNameResult
    try {
      result = await this.generateName(conversationText, existingNames, requireName, {
        workspaceId: stream.workspaceId,
      })
    } catch (err) {
      logger.error({ err, streamId }, "Failed to generate stream name")
      throw err
    }

    if (!result.name) {
      logger.debug({ streamId, messageCount: messages.length }, "Not enough context for auto-naming yet")
      return false
    }

    const cleanName = result.name

    // Phase 3: Save result in ONE transaction (fast, ~100ms)
    // Re-check that stream still needs naming (another process may have named it)
    return withTransaction(this.pool, async (client) => {
      // Lock the stream row to ensure atomicity
      const currentStream = await StreamRepository.findByIdForUpdate(client, streamId)
      if (!currentStream) {
        logger.debug({ streamId }, "Stream disappeared during naming, skipping")
        return false
      }

      // Re-check: another process might have named it while we were generating
      if (!needsAutoNaming(currentStream)) {
        logger.debug({ streamId }, "Stream was named by another process, skipping")
        return false
      }

      // Update the stream with the generated name
      await StreamRepository.update(client, streamId, {
        displayName: cleanName,
        displayNameGeneratedAt: new Date(),
      })

      // Emit to outbox for real-time delivery
      await OutboxRepository.insert(client, "stream:display_name_updated", {
        workspaceId: stream.workspaceId,
        streamId,
        displayName: cleanName,
        visibility: currentStream.visibility,
      })

      logger.info({ streamId, displayName: cleanName, requireName }, "Auto-generated stream display name")

      return true
    })
  }
}
