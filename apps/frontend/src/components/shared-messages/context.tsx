import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { AttachmentSummary, StreamType, Visibility } from "@threa/types"

/**
 * Hydrated payload for a pointer message. Kept structurally aligned with
 * the backend's `HydratedSharedMessage` discriminated union.
 *
 * - `private`: viewer has no read path to the source; reveals only the
 *   source stream's kind + visibility.
 * - `truncated`: hydration stopped at the depth cap; viewer has access.
 */
export type HydratedSharedMessage =
  | {
      state: "ok"
      messageId: string
      streamId: string
      authorId: string
      authorName?: string
      authorType: string
      contentJson: unknown
      contentMarkdown: string
      editedAt: string | null
      createdAt: string
      attachments: AttachmentSummary[]
    }
  | { state: "deleted"; messageId: string; deletedAt: string }
  | { state: "missing"; messageId: string }
  | {
      state: "private"
      messageId: string
      sourceStreamKind: StreamType
      sourceVisibility: Visibility
    }
  | { state: "truncated"; messageId: string; streamId: string }

interface SharedMessagesContextValue {
  get: (messageId: string) => HydratedSharedMessage | null
}

const SharedMessagesCtx = createContext<SharedMessagesContextValue | null>(null)

/**
 * Provides the timeline's `sharedMessages` hydration map to any descendant
 * `SharedMessageView` NodeView. The map lives in the stream bootstrap / event
 * list response and is plumbed in by the timeline container. A miss returns
 * `null` so the view renders the pre-hydration skeleton rather than crash.
 */
export function SharedMessagesProvider({
  map,
  children,
}: {
  map: Record<string, HydratedSharedMessage> | undefined | null
  children: ReactNode
}) {
  const value = useMemo<SharedMessagesContextValue>(() => {
    const snapshot = map ?? {}
    return {
      get: (messageId: string) => snapshot[messageId] ?? null,
    }
  }, [map])
  return <SharedMessagesCtx.Provider value={value}>{children}</SharedMessagesCtx.Provider>
}

export function useSharedMessageHydration(messageId: string): HydratedSharedMessage | null {
  const ctx = useContext(SharedMessagesCtx)
  if (!ctx) return null
  return ctx.get(messageId)
}
