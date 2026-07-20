import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react"
import { db } from "@/db"
import { serializeToMarkdown } from "@threa/prosemirror"
import { ConversationIntents, type JSONContent } from "@threa/types"
import { deleteOptimisticBoardPost } from "@/stores/board-store"

type MessageStatus = "pending" | "failed" | "editing"
/** Status the message had before the user entered editing mode */
type PreEditStatus = "pending" | "failed"

interface PendingMessagesContextValue {
  getStatus: (id: string) => MessageStatus | null
  markPending: (id: string) => void
  markFailed: (id: string) => void
  markSent: (id: string) => void
  /** Put a pending/failed message into editing mode so the queue skips it */
  markEditing: (id: string) => Promise<void>
  /** Save edits to an unsent message, return it to pending, and kick the queue */
  saveEditedMessage: (id: string, contentJson: JSONContent) => Promise<void>
  /** Cancel editing and return message to its previous queue state */
  cancelEditing: (id: string) => Promise<void>
  /**
   * Reset a failed message's retry count and re-enqueue it for sending.
   * Optionally patches additional fields onto the pending row first — used
   * by the share-privacy toast to set `confirmedPrivacyWarning: true` and
   * clear the `blocked-privacy` status in one atomic resume.
   */
  retryMessage: (id: string, patch?: Record<string, unknown>) => Promise<void>
  /** Permanently delete a failed/pending message from the outbox and timeline */
  deleteMessage: (id: string) => Promise<void>
  /** Kick the background message queue to process the next pending message */
  notifyQueue: () => void
  /** Register the queue's notify callback (called by useMessageQueue). Pass null to unregister. */
  registerQueueNotify: (fn: (() => void) | null) => void
}

const PendingMessagesContext = createContext<PendingMessagesContextValue | null>(null)

interface PendingMessagesProviderProps {
  children: ReactNode
}

export function PendingMessagesProvider({ children }: PendingMessagesProviderProps) {
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [failedIds, setFailedIds] = useState<Set<string>>(new Set())
  // Maps editing message ID → status it had before entering edit mode
  const [editingIds, setEditingIds] = useState<Map<string, PreEditStatus>>(new Map())
  const queueNotifyRef = useRef<(() => void) | null>(null)

  // Hydrate pending/failed state from IDB on mount so it survives page reload.
  // Editing is intentionally NOT restored across reloads: if the app refreshes
  // or hot-reloads while an unsent-message edit drawer is open, reopening that
  // transient UI on startup hides the main composer again on mobile. Instead we
  // normalize persisted "editing" rows back to their pre-edit queue status and
  // let the user explicitly re-enter edit mode if needed.
  useEffect(() => {
    void (async () => {
      try {
        const pending = await db.events.where("_status").equals("pending").primaryKeys()
        const failed = await db.events.where("_status").equals("failed").primaryKeys()
        const editing = await db.events.where("_status").equals("editing").primaryKeys()
        if (pending.length > 0) setPendingIds(new Set(pending as string[]))
        if (failed.length > 0) setFailedIds(new Set(failed as string[]))
        if (editing.length > 0) {
          const restoredPendingIds = new Set<string>()
          const restoredFailedIds = new Set<string>()

          await db.transaction("rw", db.pendingMessages, db.events, async () => {
            for (const rawId of editing) {
              const id = rawId as string
              const pendingMessage = await db.pendingMessages.get(id)
              const preEditStatus = pendingMessage?.preEditStatus ?? "pending"

              type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
              await (db.pendingMessages.update as unknown as UpdateFn)(id, {
                status: undefined,
                preEditStatus: undefined,
              })
              await db.events.update(id, { _status: preEditStatus })

              if (preEditStatus === "failed") {
                restoredFailedIds.add(id)
              } else {
                restoredPendingIds.add(id)
              }
            }
          })

          setPendingIds((prev) => new Set([...prev, ...restoredPendingIds]))
          setFailedIds((prev) => new Set([...prev, ...restoredFailedIds]))
          setEditingIds(new Map())
          if (restoredPendingIds.size > 0) {
            // Defer until after descendants mount so useMessageQueue has time
            // to register its notify callback during the same startup commit.
            setTimeout(() => queueNotifyRef.current?.(), 0)
          }
        }
      } catch {
        // Best-effort — works in browser, may fail in test environment mocks
      }
    })()
  }, [])

  const getStatus = useCallback(
    (id: string): MessageStatus | null => {
      if (editingIds.has(id)) return "editing"
      if (pendingIds.has(id)) return "pending"
      if (failedIds.has(id)) return "failed"
      return null
    },
    [pendingIds, failedIds, editingIds]
  )

  const markPending = useCallback((id: string) => {
    setPendingIds((prev) => new Set(prev).add(id))
    setFailedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setEditingIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const markFailed = useCallback((id: string) => {
    setFailedIds((prev) => new Set(prev).add(id))
    setPendingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setEditingIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const markSent = useCallback((id: string) => {
    setPendingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setFailedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setEditingIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const notifyQueue = useCallback(() => {
    queueNotifyRef.current?.()
  }, [])

  const registerQueueNotify = useCallback((fn: (() => void) | null) => {
    if (process.env.NODE_ENV !== "production" && fn && queueNotifyRef.current) {
      console.warn("registerQueueNotify: overwriting an existing callback — only one queue processor should be mounted")
    }
    queueNotifyRef.current = fn
  }, [])

  const markEditing = useCallback(async (id: string) => {
    const existing = await db.pendingMessages.get(id)
    if (!existing) return

    // Already being edited (e.g. double-click race)
    if (existing.status === "editing") return

    // Read pre-edit status inside the transaction so the queue can't change it
    // between the read and the write
    const preEditStatus = await db.transaction("rw", db.pendingMessages, db.events, async () => {
      const event = await db.events.get(id)
      const status: PreEditStatus = event?._status === "failed" ? "failed" : "pending"

      type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
      await (db.pendingMessages.update as unknown as UpdateFn)(id, { status: "editing", preEditStatus: status })
      await db.events.update(id, { _status: "editing" })
      return status
    })

    setEditingIds((prev) => new Map(prev).set(id, preEditStatus))
    setPendingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setFailedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const saveEditedMessage = useCallback(
    async (id: string, contentJson: JSONContent) => {
      const contentMarkdown = serializeToMarkdown(contentJson).trim()

      const updated = await db.transaction("rw", db.pendingMessages, db.events, async () => {
        const existing = await db.pendingMessages.get(id)
        if (!existing) return false

        type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
        await (db.pendingMessages.update as unknown as UpdateFn)(id, {
          content: contentMarkdown,
          contentJson,
          status: undefined, // clear editing hold
          preEditStatus: undefined,
          retryCount: 0,
          retryAfter: 0,
        })

        // Update the optimistic event's payload so the timeline reflects the edit
        const event = await db.events.get(id)
        if (event) {
          const payload = event.payload as Record<string, unknown>
          await db.events.put({
            ...event,
            payload: { ...payload, contentMarkdown, contentJson },
            _status: "pending",
          })
        }
        return true
      })

      if (!updated) return

      setPendingIds((prev) => new Set(prev).add(id))
      setEditingIds((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      notifyQueue()
    },
    [notifyQueue]
  )

  const cancelEditing = useCallback(
    async (id: string) => {
      const preEditStatus: PreEditStatus = editingIds.get(id) ?? "pending"

      const restored = await db.transaction("rw", db.pendingMessages, db.events, async () => {
        const existing = await db.pendingMessages.get(id)
        if (!existing) return false

        type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
        await (db.pendingMessages.update as unknown as UpdateFn)(id, { status: undefined, preEditStatus: undefined })
        await db.events.update(id, { _status: preEditStatus })
        return true
      })

      if (!restored) return

      setEditingIds((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      if (preEditStatus === "failed") {
        setFailedIds((prev) => new Set(prev).add(id))
      } else {
        setPendingIds((prev) => new Set(prev).add(id))
        notifyQueue()
      }
    },
    [editingIds, notifyQueue]
  )

  const retryMessage = useCallback(
    async (id: string, patch?: Record<string, unknown>) => {
      // Verify the message still exists — the user may have deleted it
      // while the retry button was visible. Without this guard, markPending
      // would lock the UI in "pending" with no queue record to resolve it.
      const existing = await db.pendingMessages.get(id)
      if (!existing) return

      // Reset retry count AND backoff so the queue picks it up immediately.
      // Dexie's deep KeyPaths inference hits a circular type on JSONContent.
      // Cast through unknown to bypass the broken type inference.
      type UpdateFn = (key: string, changes: Record<string, unknown>) => Promise<number>
      await (db.pendingMessages.update as unknown as UpdateFn)(id, {
        retryCount: 0,
        retryAfter: 0,
        status: undefined,
        terminalFailure: undefined,
        ...patch,
      })
      await db.events.update(id, { _status: "pending" })
      markPending(id)
      notifyQueue()
    },
    [markPending, notifyQueue]
  )

  const deleteMessage = useCallback(async (id: string) => {
    // Read the directive before deleting: a cancelled new-scratchpad board post
    // also drops its composer-clear optimistic card (keyed by the client-minted
    // conversation id) so it doesn't linger as a phantom that never reconciles.
    const pending = await db.pendingMessages.get(id)
    await db.transaction("rw", db.pendingMessages, db.events, async () => {
      await db.pendingMessages.delete(id)
      await db.events.delete(id)
    })
    if (pending?.conversation?.intent === ConversationIntents.NEW && pending.conversation.conversationId) {
      await deleteOptimisticBoardPost(pending.conversation.conversationId)
    }
    setPendingIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setFailedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setEditingIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  return (
    <PendingMessagesContext.Provider
      value={{
        getStatus,
        markPending,
        markFailed,
        markSent,
        markEditing,
        saveEditedMessage,
        cancelEditing,
        retryMessage,
        deleteMessage,
        notifyQueue,
        registerQueueNotify,
      }}
    >
      {children}
    </PendingMessagesContext.Provider>
  )
}

export function usePendingMessages(): PendingMessagesContextValue {
  const context = useContext(PendingMessagesContext)
  if (!context) {
    throw new Error("usePendingMessages must be used within a PendingMessagesProvider")
  }
  return context
}
