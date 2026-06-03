import { useEffect, useRef, useCallback } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { useSocketConnected, useMessageService, useStreamService, usePendingMessages } from "@/contexts"
import { useSyncEngine } from "@/sync/sync-engine"
import { db, sequenceToNum } from "@/db"
import { parseMarkdown } from "@threa/prosemirror"
import { emitDraftPromoted } from "@/lib/draft-promotions"
import { setParentThreadId } from "@/sync/stream-sync"
import { deleteDraftScratchpadFromCache, deleteDraftMessageFromCache } from "@/stores/draft-store"
import { workspaceKeys } from "./use-workspaces"
import { StreamTypes, ShareErrorCodes } from "@threa/types"
import type { PendingMessage } from "@/db"
import type { CreateStreamInput, Stream, StreamWithPreview } from "@threa/types"
import { ApiError } from "@/api/client"
import { surfacePrivacyBlockToast } from "@/lib/share-privacy-toast"

/**
 * Exponential backoff delay based on retry count.
 * First 3 retries are immediate (within the same drain cycle, skipped to next cycle).
 * After that, delays increase to prevent hammering a down server.
 */
function getRetryDelay(retryCount: number): number {
  if (retryCount <= 3) return 0
  if (retryCount <= 6) return 5_000
  if (retryCount <= 10) return 30_000
  return 120_000 // 2 min cap
}

/**
 * Promote a draft by creating the real stream, moving the optimistic event,
 * and cleaning up draft data. Returns the real stream ID.
 *
 * Idempotent: `promotedStreamId` is persisted on the pending message
 * immediately after stream creation succeeds. On retry, if the field is
 * already set we skip creation and reuse the existing stream, preventing
 * duplicates even when the IDB update that clears `streamCreation` fails.
 */
async function promoteDraft(
  next: PendingMessage,
  streamService: { create: (workspaceId: string, data: CreateStreamInput) => Promise<Stream> },
  syncEngine: { subscribeStream: (id: string) => Promise<void> },
  queryClient: QueryClient
): Promise<string> {
  const creation = next.streamCreation!
  const draftStreamId = next.streamId

  let realStreamId: string

  if (next.promotedStreamId) {
    // Stream was already created on a previous attempt — reuse it
    realStreamId = next.promotedStreamId
  } else {
    const newStream = await streamService.create(next.workspaceId, {
      type: creation.type,
      displayName: creation.displayName,
      companionMode: creation.companionMode,
      parentStreamId: creation.parentStreamId,
      parentMessageId: creation.parentMessageId,
    })
    realStreamId = newStream.id

    // Persist realStreamId immediately so retries never create a duplicate.
    // This write is the durable idempotency marker — even if everything
    // after this point fails, the next attempt will find promotedStreamId
    // and skip stream creation.
    type PromoteFn = (key: string, changes: Record<string, unknown>) => Promise<number>
    await (db.pendingMessages.update as unknown as PromoteFn)(next.clientId, {
      promotedStreamId: realStreamId,
    })

    // Write the new stream to IDB so the sidebar picks it up immediately
    await db.streams.put({
      ...newStream,
      lastMessagePreview: null,
      _cachedAt: Date.now(),
    })

    // Add the new stream to the sidebar bootstrap cache
    queryClient.setQueryData(workspaceKeys.bootstrap(next.workspaceId), (old: any) => {
      if (!old) return old
      const streamExists = old.streams?.some((s: { id: string }) => s.id === realStreamId)
      if (streamExists) return old
      const optimisticBootstrapStream: StreamWithPreview = {
        ...newStream,
        lastMessagePreview: null,
      }
      return {
        ...old,
        streams: [...(old.streams ?? []), optimisticBootstrapStream],
      }
    })
  }

  // Update the pending message's streamId and clear streamCreation
  type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
  await (db.pendingMessages.update as unknown as UpdateFn)(next.clientId, {
    streamId: realStreamId,
    streamCreation: undefined,
  })

  // Move the optimistic event from draft streamId to real streamId
  const optimisticEvent = await db.events.get(next.clientId)
  if (optimisticEvent) {
    await db.events.put({
      ...optimisticEvent,
      streamId: realStreamId,
      _sequenceNum: sequenceToNum(optimisticEvent.sequence),
    })
  }

  // Subscribe to the real stream's socket room before sending so we catch
  // the message:created event for the optimistic swap
  void syncEngine.subscribeStream(realStreamId)

  // For threads, swap the parent message's threadId from the draft panel ID
  // to the real thread stream. The replyCount was already bumped at queue time
  // so we don't re-increment here.
  if (creation.type === StreamTypes.THREAD && creation.parentStreamId && creation.parentMessageId) {
    setParentThreadId(creation.parentStreamId, creation.parentMessageId, realStreamId).catch(() => {})
  }

  // Clean up draft data (no-ops gracefully for non-scratchpad drafts).
  // Also delete the optimistic scratchpad stream entry that was created at
  // queue time — the real stream now replaces it in the sidebar.
  if (next.draftId) {
    await db.transaction("rw", db.draftScratchpads, db.draftMessages, db.streams, async () => {
      await db.draftScratchpads.delete(next.draftId!)
      await db.draftMessages.delete(`stream:${next.draftId!}`)
      if (draftStreamId !== realStreamId) {
        await db.streams.delete(draftStreamId)
      }
    })
    deleteDraftScratchpadFromCache(next.workspaceId, next.draftId)
    deleteDraftMessageFromCache(next.workspaceId, `stream:${next.draftId}`)
  }

  // Notify UI to navigate from draft to real stream
  emitDraftPromoted({
    draftId: draftStreamId,
    realStreamId,
    workspaceId: next.workspaceId,
  })

  return realStreamId
}

/**
 * Background queue processor that drains pending messages from IndexedDB.
 *
 * Messages are sent in createdAt order, one at a time. The queue is triggered
 * whenever a new message is enqueued (via context `notifyQueue()`) or the
 * socket reconnects.
 *
 * Key invariants:
 * - Messages are NEVER deleted from the queue on failure. They stay until
 *   confirmed by the server or manually deleted by the user.
 * - Offline detection prevents retries from consuming backoff slots — only
 *   genuine send failures (while connected) increment retryCount.
 * - Exponential backoff via `retryAfter` prevents hammering after failures.
 * - Web Locks API prevents multiple tabs from processing the same message.
 * - Failed messages are skipped so newer messages aren't blocked.
 */
export function useMessageQueue(): void {
  const isConnected = useSocketConnected()
  const messageService = useMessageService()
  const streamService = useStreamService()
  const syncEngine = useSyncEngine()
  const queryClient = useQueryClient()
  const { markPending, markFailed, markSent, registerQueueNotify, retryMessage, deleteMessage } = usePendingMessages()

  const isProcessing = useRef(false)
  const hasPendingWork = useRef(false)
  const isConnectedRef = useRef(isConnected)
  isConnectedRef.current = isConnected

  const drainQueue = useCallback(async () => {
    const now = Date.now()
    // Track messages that failed in this drain cycle so we skip past them
    // and deliver newer messages instead of blocking at the head of the queue.
    const skippedIds = new Set<string>()

    while (true) {
      if (!isConnectedRef.current) break

      const candidates = await db.pendingMessages.orderBy("createdAt").toArray()
      const next = candidates.find(
        (m) =>
          !skippedIds.has(m.clientId) &&
          m.status !== "editing" &&
          // Privacy-blocked sends wait for the user to click "Share anyway"
          // (which clears the status); the drain loop must skip them so they
          // don't churn through retries the user hasn't authorized yet.
          m.status !== "blocked-privacy" &&
          (m.retryAfter ?? 0) <= now
      )
      if (!next) break

      // Re-check status from IDB to close the TOCTOU window: the user may
      // have clicked Edit between the snapshot read above and now.
      const fresh = await db.pendingMessages.get(next.clientId)
      if (!fresh || fresh.status === "editing") {
        skippedIds.add(next.clientId)
        continue
      }

      markPending(next.clientId)
      await db.events.update(next.clientId, { _status: "pending" })

      try {
        // If this message needs a stream created first, promote the draft
        if (next.streamCreation) {
          const realStreamId = await promoteDraft(next, streamService, syncEngine, queryClient)
          // Re-read the message after promotion (streamId was updated)
          next.streamId = realStreamId
          next.streamCreation = undefined
        }

        if (next.ciphertext && next.envelope && next.e2eVersion) {
          // E2E branch — encryption already happened at queue time so the
          // drain stays identity-agnostic. The backend's INV-E1 gate
          // rejects this variant on plaintext streams loudly.
          if (next.attachmentIds && next.attachmentIds.length > 0) {
            // The enqueue path (`useStreamOrDraft.sendMessage`) refuses E2E
            // sends carrying attachments; a row that reaches the drain with
            // both is a contract bug, not a recoverable state. Fail loud so
            // the failed-message UI surfaces it instead of silently dropping
            // the chip the optimistic event already rendered.
            throw new Error("Attachments aren't supported in encrypted scratchpads yet")
          }
          await messageService.create(next.workspaceId, next.streamId, {
            streamId: next.streamId,
            ciphertext: next.ciphertext,
            envelope: next.envelope,
            e2eVersion: next.e2eVersion,
            clientMessageId: next.clientId,
          })
        } else {
          const contentJson = next.contentJson ?? parseMarkdown(next.content)
          await messageService.create(next.workspaceId, next.streamId, {
            streamId: next.streamId,
            contentJson,
            attachmentIds: next.attachmentIds,
            clientMessageId: next.clientId,
            confirmedPrivacyWarning: next.confirmedPrivacyWarning,
          })
        }

        await db.pendingMessages.delete(next.clientId)

        // Do NOT delete the optimistic event from db.events here.
        // The socket handler (handleMessageCreated in stream-sync.ts) atomically
        // swaps the optimistic event for the real server event in a single
        // Dexie transaction.
        markSent(next.clientId)
      } catch (err) {
        // Privacy boundary block: the user authored a share that would
        // expose its source to people outside the source stream. Don't
        // auto-retry — surface a toast offering "Share anyway" / "Cancel"
        // so the user explicitly confirms or aborts. INV-32: the API
        // contract surfaces this as 409 + a stable error code.
        if (
          ApiError.isApiError(err) &&
          err.status === 409 &&
          err.code === ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED
        ) {
          // Dexie's deep KeyPaths inference hits a circular type on JSONContent.
          type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
          await Promise.all([
            (db.pendingMessages.update as unknown as UpdateFn)(next.clientId, {
              status: "blocked-privacy",
              retryAfter: undefined,
            }),
            db.events.update(next.clientId, { _status: "failed" }),
          ])
          markFailed(next.clientId)
          surfacePrivacyBlockToast(next.clientId, { retryMessage, deleteMessage })
          skippedIds.add(next.clientId)
          continue
        }

        // Increment retry count and set backoff delay.
        // Only genuine send failures (while connected) reach here —
        // the offline check at the top of the loop prevents transient
        // connectivity issues from consuming backoff slots.
        const retryCount = next.retryCount + 1
        const delay = getRetryDelay(retryCount)
        // Dexie's deep KeyPaths inference hits a circular type on JSONContent.
        type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
        await (db.pendingMessages.update as unknown as UpdateFn)(next.clientId, {
          retryCount,
          retryAfter: Date.now() + delay,
        })
        await db.events.update(next.clientId, { _status: "failed" })
        markFailed(next.clientId)
        // Skip this message for the rest of this drain cycle so newer
        // messages are not blocked behind it.
        skippedIds.add(next.clientId)
      }
    }
  }, [
    messageService,
    streamService,
    syncEngine,
    queryClient,
    markPending,
    markFailed,
    markSent,
    retryMessage,
    deleteMessage,
  ])

  const processQueue = useCallback(async () => {
    if (isProcessing.current) {
      hasPendingWork.current = true
      return
    }

    isProcessing.current = true
    hasPendingWork.current = false

    try {
      // Cross-tab safety: only one tab processes the outbox at a time.
      // If another tab holds the lock, we skip — it's already processing.
      if (navigator.locks) {
        await navigator.locks.request("threa-outbox", { ifAvailable: true }, async (lock) => {
          if (!lock) return // Another tab is processing
          await drainQueue()
        })
      } else {
        // Fallback for browsers without Web Locks API
        await drainQueue()
      }
    } finally {
      isProcessing.current = false

      if (hasPendingWork.current) {
        hasPendingWork.current = false
        void processQueue()
      }
    }
  }, [drainQueue])

  // Register notify callback so other hooks can kick the queue via context
  useEffect(() => {
    registerQueueNotify(() => void processQueue())
    return () => registerQueueNotify(null)
  }, [registerQueueNotify, processQueue])

  // Drain queue when socket (re)connects
  useEffect(() => {
    if (isConnected) {
      void processQueue()
    }
  }, [isConnected, processQueue])
}
