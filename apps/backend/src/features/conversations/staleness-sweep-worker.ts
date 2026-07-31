import type { Pool } from "pg"
import type { ConversationStalenessSweepJobData, JobHandler } from "../../lib/queue"
import { withTransaction } from "../../db"
import { StreamRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { ConversationRepository } from "./repository"
import { MessageConversationStateRepository } from "./settling-repository"
import { emitSettledConversationUpdates } from "./settling-service"
import { SETTLING_MAX_AGE_SECONDS } from "./boundary-extraction/config"
import { addStalenessFields } from "./staleness"
import { resolveConversationDelivery } from "./conversation-delivery"
import { logger } from "../../lib/logger"

/** Idle time before an active conversation fades to stalled: one missed session. */
export const SWEEP_STALLED_AFTER_SECONDS = 24 * 60 * 60
/** Idle time before a stalled (or long-idle active) conversation resolves. */
export const SWEEP_RESOLVED_AFTER_SECONDS = 7 * 24 * 60 * 60
/** Per-run cap so the first sweep over a months-old backlog drains in slices. */
export const SWEEP_BATCH_LIMIT = 200

export interface StalenessSweepWorkerDeps {
  pool: Pool
}

/**
 * Cron-driven fade for conversations the extractor can no longer see: the LLM
 * only closes conversations inside its message window, so out-of-window ones
 * would stay "active" forever (prod audit: hundreds of months-old actives).
 *
 * Transitions + their outbox events commit in one transaction (INV-4/7). The
 * events carry `origin: "staleness-sweep"` so the memo accumulator can ignore
 * pure status fades — re-queueing an idle conversation for memo processing
 * would re-run extraction over months-old content.
 */
export function createStalenessSweepWorker(
  deps: StalenessSweepWorkerDeps
): JobHandler<ConversationStalenessSweepJobData> {
  const { pool } = deps

  return async (job) => {
    // Settling backstop: a quiet stream gets no further extraction pass, so
    // nothing else will ever move its window past these rows. Own transaction —
    // it must land even when no conversation transitioned.
    const settled = await withTransaction(pool, async (client) => {
      const rows = await MessageConversationStateRepository.settleOlderThan(
        client,
        SETTLING_MAX_AGE_SECONDS,
        SWEEP_BATCH_LIMIT
      )
      // The sweep spans workspaces; the emit is workspace-scoped (INV-8).
      const byWorkspace = new Map<string, typeof rows>()
      for (const row of rows) {
        const existing = byWorkspace.get(row.workspaceId)
        if (existing) existing.push(row)
        else byWorkspace.set(row.workspaceId, [row])
      }
      for (const [wsId, wsRows] of byWorkspace) {
        await emitSettledConversationUpdates(client, wsId, wsRows)
      }
      return rows
    })
    if (settled.length > 0) {
      logger.info({ jobId: job.id, settled: settled.length }, "Staleness sweep settled stale settling assignments")
    }

    const swept = await withTransaction(pool, async (client) => {
      const transitioned = await ConversationRepository.sweepStale(client, {
        stalledAfterSeconds: SWEEP_STALLED_AFTER_SECONDS,
        resolvedAfterSeconds: SWEEP_RESOLVED_AFTER_SECONDS,
        limit: SWEEP_BATCH_LIMIT,
      })
      if (transitioned.length === 0) return 0

      // Route each event by its conversation's own access root (INV-62).
      // Streams are batch-fetched and delivery resolved once per distinct
      // stream; the events land in one insertMany (INV-56) so the transaction
      // holds the connection for two round-trips plus thread-parent lookups,
      // not one insert per row.
      const streamIds = [...new Set(transitioned.map((c) => c.streamId))]
      const streams = await StreamRepository.findByIds(client, streamIds)
      const streamById = new Map(streams.map((s) => [s.id, s]))
      const deliveryByStreamId = new Map<string, Awaited<ReturnType<typeof resolveConversationDelivery>>>()
      for (const id of streamIds) {
        deliveryByStreamId.set(id, await resolveConversationDelivery(client, streamById.get(id) ?? null))
      }
      // The sweep spans workspaces, and the settling read is workspace-scoped
      // (INV-8), so it runs once per workspace present in the batch.
      const settlingByConversation = new Map<string, string[]>()
      const idsByWorkspace = new Map<string, string[]>()
      for (const conv of transitioned) {
        const ids = idsByWorkspace.get(conv.workspaceId)
        if (ids) ids.push(conv.id)
        else idsByWorkspace.set(conv.workspaceId, [conv.id])
      }
      for (const [wsId, ids] of idsByWorkspace) {
        for (const [convId, messageIds] of await MessageConversationStateRepository.listSettlingByConversationIds(
          client,
          wsId,
          ids
        )) {
          settlingByConversation.set(convId, messageIds)
        }
      }
      await OutboxRepository.insertMany(
        client,
        transitioned.map((conv) => {
          const delivery = deliveryByStreamId.get(conv.streamId)
          return {
            eventType: "conversation:updated" as const,
            payload: {
              workspaceId: conv.workspaceId,
              streamId: conv.streamId,
              conversationId: conv.id,
              conversation: addStalenessFields(conv),
              parentStreamId: delivery?.parentStreamId,
              streamVisibility: delivery?.streamVisibility,
              settlingMessageIds: settlingByConversation.get(conv.id) ?? [],
              origin: "staleness-sweep" as const,
            },
          }
        })
      )
      return transitioned.length
    })

    if (swept > 0) {
      logger.info({ jobId: job.id, swept }, "Staleness sweep transitioned idle conversations")
    }
  }
}
