import type { Pool } from "pg"
import { AuthorTypes, CompanionModes, StreamTypes } from "@threa/types"
import { CursorLock, DebounceWithMaxWait, ensureListenerFromLatest, type ProcessResult } from "@threa/backend-common"
import { OutboxRepository, parseMessagePayload, type OutboxHandler } from "../../../lib/outbox"
import { JobQueues, type QueueManager } from "../../../lib/queue"
import { resolveDeliveryVerdict, TrustTiers } from "@threa/agent-runtime"
import { resolveSealingContext } from "../../e2e-streams"
import { StreamRepository } from "../../streams"
import { logger } from "../../../lib/logger"

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

/**
 * Dispatches an enclave-invoke job for each user message in an E2E scratchpad
 * that has the enclave actor invited. The mirror image of `CompanionHandler`:
 * companion mode is forced off on E2E streams (Ariadne can't see ciphertext via
 * the normal path), so the enclave path triggers on the invited actor instead.
 * Only user messages enqueue — the persona-authored reply never re-triggers.
 */
export class EnclaveDispatchHandler implements OutboxHandler {
  readonly listenerId = "enclave_dispatch"

  private readonly db: Pool
  private readonly jobQueue: QueueManager
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, jobQueue: QueueManager) {
    this.db = db
    this.jobQueue = jobQueue
    this.batchSize = DEFAULT_CONFIG.batchSize
    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })
    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      DEFAULT_CONFIG.debounceMs,
      DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "EnclaveDispatchHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  handle(): void {
    this.debouncer.trigger()
  }

  private async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.db, cursor, this.batchSize, processedIds)
      if (events.length === 0) return { status: "no_events" }

      const seen: bigint[] = []
      try {
        for (const event of events) {
          if (event.eventType !== "message:created") {
            seen.push(event.id)
            continue
          }
          const payload = parseMessagePayload(event.payload)
          if (!payload) {
            seen.push(event.id)
            continue
          }
          const { streamId, workspaceId, event: messageEvent } = payload

          // Only E2E streams (the inverse of CompanionHandler), and only user
          // turns — a persona/bot message must not trigger a reply loop.
          if (messageEvent.actorType !== AuthorTypes.USER || !messageEvent.actorId) {
            seen.push(event.id)
            continue
          }
          // The enclave is a sealed driver: it only takes turns the delivery
          // verdict seals — an E2E stream with the enclave actor invited.
          // Plaintext streams and uninvited E2E streams both come back
          // non-sealed and are the companion's (or nobody's) turn.
          const sealing = await resolveSealingContext(this.db, {
            workspaceId,
            streamId,
            actor: { kind: "enclave" },
          })
          const verdict = resolveDeliveryVerdict({ trust: TrustTiers.FIRST_PARTY_ATTESTED, sealing })
          if (verdict.delivery !== "sealed") {
            seen.push(event.id)
            continue
          }

          // Honest companion toggle: the enclave only auto-replies when the
          // scratchpad's companion mode is ON. "Quiet" means a silent encrypted
          // dump — the enclave actor stays invited (so flipping to Companion
          // works instantly) but no turn is dispatched. Threads inherit the
          // root scratchpad's mode live, mirroring CompanionHandler, so a root
          // toggled after the thread was created is still respected.
          const stream = await StreamRepository.findById(this.db, streamId)
          if (!stream) {
            seen.push(event.id)
            continue
          }
          let companionSource = stream
          if (stream.companionMode !== CompanionModes.ON && stream.rootStreamId) {
            const rootStream = await StreamRepository.findById(this.db, stream.rootStreamId)
            if (
              rootStream &&
              rootStream.type === StreamTypes.SCRATCHPAD &&
              rootStream.companionMode === CompanionModes.ON
            ) {
              companionSource = rootStream
            }
          }
          if (companionSource.companionMode !== CompanionModes.ON) {
            seen.push(event.id)
            continue
          }

          await this.jobQueue.send(JobQueues.ENCLAVE_INVOKE, {
            workspaceId,
            streamId,
            messageId: messageEvent.payload.messageId,
            triggeredBy: messageEvent.actorId,
          })
          logger.info(
            { workspaceId, streamId, messageId: messageEvent.payload.messageId },
            "Enclave invoke job dispatched"
          )
          seen.push(event.id)
        }
        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        return seen.length > 0 ? { status: "error", error, processedIds: seen } : { status: "error", error }
      }
    })
  }
}
