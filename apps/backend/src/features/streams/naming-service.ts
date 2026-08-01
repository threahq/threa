import { Pool } from "pg"
import { Visibilities } from "@threa/types"
import { withTransaction, withClient } from "../../db"
import { StreamRepository } from "./repository"
import { resolveEffectiveAccessStream } from "./access"
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
import { awaitLinkPreviewProcessing, enrichMessagesWithLinkPreviewMap } from "../link-previews"
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
   * Pure naming logic without database integration.
   *
   * @param requireName If true, NOT_ENOUGH_CONTEXT throws instead of returning null
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
   * Auto-generate a display name for a stream after a message is created.
   *
   * Uses the three-phase pattern (INV-41) to avoid holding DB connections during
   * the slow AI call: fetch data, run the AI call with no connection held, then
   * save in one transaction. Phase 3 re-checks under a row lock because another
   * process may name the stream while we generate — that wastes one AI call but
   * prevents pool exhaustion from holding connections across AI operations.
   *
   * @param requireName If true, must generate a name (throws if NOT_ENOUGH_CONTEXT).
   * @returns true if a name was successfully generated and saved.
   */
  async attemptAutoNaming(streamId: string, requireName: boolean): Promise<boolean> {
    // Phase 1: fetch all data with withClient (no transaction)
    const fetchedData = await withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream) {
        return { stream: null, messages: [], otherStreams: [], attachmentIds: [] }
      }

      if (!needsAutoNaming(stream)) {
        return { stream: null, messages: [], otherStreams: [], attachmentIds: [] }
      }

      const messages = await MessageRepository.list(client, streamId, {
        limit: MAX_MESSAGES_FOR_NAMING,
      })

      if (messages.length === 0) {
        return { stream: null, messages: [], otherStreams: [], attachmentIds: [] }
      }

      // Existing names in the workspace are passed to the prompt to avoid duplicates
      const otherStreams = await StreamRepository.list(client, stream.workspaceId, { types: [stream.type] })

      const messageIds = messages.map((m) => m.id)
      const attachmentsByMessage = await AttachmentRepository.findByMessageIds(client, messageIds)

      const attachmentIds: string[] = []
      for (const attachments of attachmentsByMessage.values()) {
        for (const a of attachments) {
          attachmentIds.push(a.id)
        }
      }

      return { stream, messages, otherStreams, attachmentIds }
    })

    if (!fetchedData.stream) {
      return false
    }

    const { stream, messages, otherStreams, attachmentIds } = fetchedData

    const linkPreviewProcessing = awaitLinkPreviewProcessing(this.pool, stream.workspaceId, messages)

    // Await attachment processing (no connection held) so extractions are
    // available before formatting the conversation
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

    const linkPreviewResult = await linkPreviewProcessing

    // Uses pool directly per INV-30 (single-query path)
    const messageIds = messages.map((m) => m.id)
    let attachmentsByMessageId: Map<string, AttachmentWithExtraction[]>
    if (attachmentIds.length > 0) {
      attachmentsByMessageId = await AttachmentRepository.findByMessageIdsWithExtractions(this.pool, messageIds)
    } else {
      attachmentsByMessageId = new Map()
    }

    const messagesWithLinkPreviews = enrichMessagesWithLinkPreviewMap(messages, linkPreviewResult.previewsByMessage)
    const conversationText = await this.messageFormatter.formatMessagesWithAttachments(
      this.pool,
      stream.workspaceId,
      messagesWithLinkPreviews,
      attachmentsByMessageId
    )

    // Phase 2: AI call, no connection held
    const existingNames = otherStreams
      .filter((s) => s.displayName && s.id !== streamId)
      .slice(0, MAX_EXISTING_NAMES)
      .map((s) => s.displayName!)

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

    // Phase 3: save in one transaction, re-checking under a row lock that the
    // stream still needs naming (another process may have named it meanwhile)
    return withTransaction(this.pool, async (client) => {
      const currentStream = await StreamRepository.findByIdForUpdate(client, streamId)
      if (!currentStream) {
        logger.debug({ streamId }, "Stream disappeared during naming, skipping")
        return false
      }

      if (!needsAutoNaming(currentStream)) {
        logger.debug({ streamId }, "Stream was named by another process, skipping")
        return false
      }

      await StreamRepository.update(client, streamId, {
        displayName: cleanName,
        displayNameGeneratedAt: new Date(),
      })

      // The payload's visibility gates workspace-wide fanout in
      // delivery-groups. A thread's own row can hold a stale copied "public"
      // under a since-privatized root (INV-62) — resolve the effective root so
      // a private tree's thread names never broadcast workspace-wide. A
      // dangling root (INV-1) resolves back to the thread itself: fail closed
      // to stream-scoped fanout rather than trust the stale copied value.
      const effective = await resolveEffectiveAccessStream(client, currentStream)
      const fanoutVisibility =
        currentStream.rootStreamId && effective.id !== currentStream.rootStreamId
          ? Visibilities.PRIVATE
          : effective.visibility
      await OutboxRepository.insert(client, "stream:display_name_updated", {
        workspaceId: stream.workspaceId,
        streamId,
        displayName: cleanName,
        visibility: fanoutVisibility,
      })

      logger.info({ streamId, displayName: cleanName, requireName }, "Auto-generated stream display name")

      return true
    })
  }
}
