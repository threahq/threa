import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import type { ConversationWithStaleness } from "@threa/types"
import { useConversations, useReassignConversationMessage } from "@/hooks/use-conversations"
import { buildConversationOverlayModel, type ConversationOverlayContext } from "./model"

export interface ConversationOverlayState {
  /**
   * Threaded into `TimelineItemRenderContext` for row decoration. Undefined
   * while the overlay is disabled so rows render exactly as before. Identity
   * is stable across viewport scrolling — in-view tracking lives outside it.
   */
  context: ConversationOverlayContext | undefined
  /**
   * Conversations with at least one message row currently on screen (in
   * model/palette order), plus the focused conversation even when scrolled
   * out of view so it can always be unfocused. Feeds the floating panel.
   */
  inViewConversations: ConversationWithStaleness[]
}

/**
 * Owns the conversation overlay's data and interaction state for one stream:
 * fetches the conversation list (live via the socket handlers inside
 * `useConversations`), derives the color/membership model, exposes the
 * focus + correction handlers the timeline rows consume, and tracks which
 * conversations currently have rows on screen.
 *
 * Viewport tracking: each decorated row registers its DOM node via
 * `context.observeRow` (React 19 ref-callback cleanup). One shared
 * IntersectionObserver maintains the visible set; ancestor clipping is part
 * of the intersection computation, so rows scrolled out of the timeline's
 * own scroll container count as off-screen. State updates are keyed on the
 * derived conversation-id set, not raw entries, so scrolling within one
 * conversation block re-renders nothing.
 */
export function useConversationOverlay({
  workspaceId,
  streamId,
  enabled,
}: {
  workspaceId: string
  streamId: string
  enabled: boolean
}): ConversationOverlayState {
  const { conversations } = useConversations(workspaceId, streamId, { enabled })
  const [focusedConversationId, setFocusedConversationId] = useState<string | null>(null)
  const reassign = useReassignConversationMessage(workspaceId, streamId)

  // Focus is ephemeral view state: drop it when the overlay closes or the
  // user navigates to another stream.
  useEffect(() => {
    setFocusedConversationId(null)
  }, [enabled, streamId])

  const model = useMemo(() => buildConversationOverlayModel(conversations, streamId), [conversations, streamId])

  // --- In-view tracking ---------------------------------------------------
  const observerRef = useRef<IntersectionObserver | null>(null)
  const conversationByElement = useRef(new Map<Element, string>())
  const visibleElements = useRef(new Set<Element>())
  const inViewKeyRef = useRef("")
  const [inViewIds, setInViewIds] = useState<ReadonlySet<string>>(() => new Set())

  const recomputeInView = useCallback(() => {
    const ids = new Set<string>()
    for (const element of visibleElements.current) {
      const conversationId = conversationByElement.current.get(element)
      if (conversationId) ids.add(conversationId)
    }
    const key = [...ids].sort().join("|")
    if (key === inViewKeyRef.current) return
    inViewKeyRef.current = key
    setInViewIds(ids)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visibleElements.current.add(entry.target)
        else visibleElements.current.delete(entry.target)
      }
      recomputeInView()
    })
    observerRef.current = observer
    // Rows mounted before the observer existed (or that survived a toggle).
    for (const element of conversationByElement.current.keys()) observer.observe(element)
    return () => {
      observer.disconnect()
      observerRef.current = null
      visibleElements.current.clear()
      inViewKeyRef.current = ""
      setInViewIds(new Set())
    }
  }, [enabled, recomputeInView])

  const observeRow = useCallback(
    (element: HTMLElement, conversationId: string) => {
      conversationByElement.current.set(element, conversationId)
      observerRef.current?.observe(element)
      return () => {
        observerRef.current?.unobserve(element)
        conversationByElement.current.delete(element)
        visibleElements.current.delete(element)
        recomputeInView()
      }
    },
    [recomputeInView]
  )
  // -------------------------------------------------------------------------

  const onToggleFocus = useCallback((conversationId: string) => {
    setFocusedConversationId((previous) => (previous === conversationId ? null : conversationId))
  }, [])

  const { mutate } = reassign
  const onReassignMessage = useCallback(
    (messageId: string, toConversationId: string) => {
      mutate(
        { messageId, toConversationId },
        {
          onError: () => toast.error("Couldn't move the message to that conversation"),
        }
      )
    },
    [mutate]
  )

  const pendingMessageId = reassign.isPending ? (reassign.variables?.messageId ?? null) : null

  const context = useMemo(
    () =>
      enabled
        ? { model, focusedConversationId, onToggleFocus, onReassignMessage, pendingMessageId, observeRow }
        : undefined,
    [enabled, model, focusedConversationId, onToggleFocus, onReassignMessage, pendingMessageId, observeRow]
  )

  const inViewConversations = useMemo(
    () => (enabled ? model.conversations.filter((c) => inViewIds.has(c.id) || c.id === focusedConversationId) : []),
    [enabled, model, inViewIds, focusedConversationId]
  )

  return { context, inViewConversations }
}
