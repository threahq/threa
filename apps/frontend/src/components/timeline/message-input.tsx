import { memo, useState, useCallback, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useNavigate } from "react-router-dom"
import {
  useDraftComposer,
  getDraftMessageKey,
  useStreamOrDraft,
  useComposerHeightPublish,
  useStashComposer,
  useMentionStreamContext,
} from "@/hooks"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePreferences } from "@/contexts"
import { useConnectionState } from "@/components/layout/connection-status"
import {
  FloatingComposerShell,
  MessageComposer,
  ScheduledMessagesPicker,
  StashedDraftsPicker,
} from "@/components/composer"
import type { ComposerControlHandle } from "@/components/composer"
import { useScheduleMessage } from "@/hooks"
import { toast } from "sonner"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { extractCommandNode } from "@/lib/commands"
import { serializeToMarkdown } from "@threa/prosemirror"
import { useEditLastMessage } from "./edit-last-message-context"
import { useQuoteReply, type QuoteReplyData } from "./quote-reply-context"
import { consumeShareHandoff, subscribeShareHandoff } from "@/stores/share-handoff-store"
import { useDiscussWithAriadne } from "@/hooks/use-discuss-with-ariadne"
import { useCommandDispatchQueue } from "@/hooks/use-command-dispatch-queue"
import { DISCUSS_WITH_ARIADNE_COMMAND, type JSONContent } from "@threa/types"
import type { PendingAttachment } from "@/hooks/use-attachments"
import { ComposerEncryptionNotice } from "@/components/encryption/stream-encryption-affordance"

interface MessageInputProps {
  workspaceId: string
  streamId: string
  disabled?: boolean
  disabledReason?: string
  autoFocus?: boolean
  /**
   * Notified when the composer's measured height changes (or when the initial
   * measurement differs from the persisted footer the list first painted with).
   * The virtualized timeline uses this to re-anchor to the bottom so the last
   * message isn't left covered by a composer that settled taller. `opts.initial`
   * marks the pre-paint first measurement so the timeline can correct it
   * synchronously instead of debouncing.
   */
  onComposerHeightChange?: (px: number, opts: { initial: boolean }) => void
}

function attachmentMatchKey(attachment: Pick<PendingAttachment, "filename" | "mimeType">): string {
  return `${attachment.filename}::${attachment.mimeType}`
}

export function extractUploadedAttachments(content: JSONContent): Array<{
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}> {
  const attachments = new Map<string, { id: string; filename: string; mimeType: string; sizeBytes: number }>()

  const visitNode = (node: JSONContent): void => {
    if (
      node.type === "attachmentReference" &&
      typeof node.attrs?.id === "string" &&
      !node.attrs.id.startsWith("temp_") &&
      typeof node.attrs?.filename === "string" &&
      typeof node.attrs?.mimeType === "string" &&
      typeof node.attrs?.sizeBytes === "number"
    ) {
      attachments.set(node.attrs.id, {
        id: node.attrs.id,
        filename: node.attrs.filename,
        mimeType: node.attrs.mimeType,
        sizeBytes: node.attrs.sizeBytes,
      })
    }

    for (const child of node.content ?? []) {
      visitNode(child)
    }
  }

  visitNode(content)
  return Array.from(attachments.values())
}

export function materializePendingAttachmentReferences(
  content: JSONContent,
  pendingAttachments: PendingAttachment[]
): JSONContent {
  const uploadedQueues = new Map<string, PendingAttachment[]>()
  for (const attachment of pendingAttachments) {
    if (attachment.status !== "uploaded") continue
    const key = attachmentMatchKey(attachment)
    const queue = uploadedQueues.get(key)
    if (queue) {
      queue.push(attachment)
    } else {
      uploadedQueues.set(key, [attachment])
    }
  }

  let nextImageIndex = 1

  const visitNode = (node: JSONContent): JSONContent => {
    if (node.type === "attachmentReference") {
      const filename = typeof node.attrs?.filename === "string" ? node.attrs.filename : ""
      const mimeType =
        typeof node.attrs?.mimeType === "string" && node.attrs.mimeType.length > 0
          ? node.attrs.mimeType
          : "application/octet-stream"
      const isImage = mimeType.startsWith("image/")
      const matchedUpload = uploadedQueues.get(attachmentMatchKey({ filename, mimeType }))?.shift()
      let imageIndex = node.attrs?.imageIndex
      if (isImage && typeof node.attrs?.imageIndex === "number" && node.attrs.imageIndex > 0) {
        imageIndex = node.attrs.imageIndex
      } else if (isImage && matchedUpload) {
        imageIndex = nextImageIndex
      }

      if (matchedUpload) {
        if (isImage) nextImageIndex += 1
        return {
          ...node,
          attrs: {
            ...node.attrs,
            id: matchedUpload.id,
            filename: matchedUpload.filename,
            mimeType: matchedUpload.mimeType,
            sizeBytes: matchedUpload.sizeBytes,
            status: "uploaded",
            imageIndex: isImage ? imageIndex : null,
            error: null,
          },
        }
      }

      if (isImage && typeof imageIndex === "number" && imageIndex > 0) {
        nextImageIndex = Math.max(nextImageIndex, imageIndex + 1)
      }
    }

    if (!node.content) {
      return node
    }

    return {
      ...node,
      content: node.content.map((child) => visitNode(child)),
    }
  }

  const materializedContent = visitNode(content)
  const remainingAttachments = Array.from(uploadedQueues.values()).flatMap((queue) => queue)
  if (remainingAttachments.length === 0) {
    return materializedContent
  }

  const fallbackParagraph: JSONContent = {
    type: "paragraph",
    content: remainingAttachments.flatMap((attachment, index) => {
      const isImage = attachment.mimeType.startsWith("image/")
      const imageIndex = isImage ? nextImageIndex++ : null

      const nodes: JSONContent[] = [
        {
          type: "attachmentReference",
          attrs: {
            id: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            status: "uploaded",
            imageIndex,
            error: null,
          },
        },
      ]

      if (index < remainingAttachments.length - 1) {
        nodes.push({ type: "text", text: " " })
      }

      return nodes
    }),
  }

  return {
    ...materializedContent,
    type: materializedContent.type ?? "doc",
    content: [...(materializedContent.content ?? []), fallbackParagraph],
  }
}

// Memoized so trace/presence-driven re-renders of `StreamContent` (which fire
// on every Pi step + heartbeat while a bot is active) don't tear through the
// composer subtree. All props here are primitives that stay reference-stable
// across `StreamContent` renders, so the default shallow comparison is enough.
export const MessageInput = memo(MessageInputComponent)

function MessageInputComponent({
  workspaceId,
  streamId,
  disabled,
  disabledReason,
  autoFocus,
  onComposerHeightChange,
}: MessageInputProps) {
  const editLastCtx = useEditLastMessage()
  const triggerEditLast = editLastCtx?.triggerEditLast
  const scrollToMessage = editLastCtx?.scrollToMessage
  const navigate = useNavigate()
  const { preferences } = usePreferences()
  const { stream, sendMessage } = useStreamOrDraft(workspaceId, streamId)
  const startDiscussWithAriadne = useDiscussWithAriadne(workspaceId)
  const scheduleMessageMutation = useScheduleMessage(workspaceId)
  const { queueCommand } = useCommandDispatchQueue(workspaceId, streamId)
  const draftKey = getDraftMessageKey({ type: "stream", streamId })

  // Broadcast/mention filtering, member/bot allow-lists, and the admin gate
  // for bot invites all live in `useMentionStreamContext`. Threads route
  // through their root channel for access grants — handled inside the hook.
  const streamContext = useMentionStreamContext(workspaceId, stream)

  const composer = useDraftComposer({
    workspaceId,
    draftKey,
    scopeId: streamId,
    e2eEnabled: stream?.e2eEnabled === true,
  })
  const quoteReplyCtx = useQuoteReply()

  // Stashed drafts — explicit "Save for later" pile scoped to this stream.
  // Active DraftMessage stays one-per-scope; this hook manages the sibling
  // many-per-scope stash and the `?stash=<id>` URL auto-restore.
  const stash = useStashComposer(composer, workspaceId, draftKey)

  // Use a ref so the handler always reads fresh composer state without
  // re-registering on every render (composer object is not memoized).
  const composerRef = useRef(composer)
  composerRef.current = composer

  // Imperative handle for programmatic focus from outside (e.g. quote reply insertion)
  const composerFocusRef = useRef<ComposerControlHandle | null>(null)

  // Register with QuoteReplyContext to insert quote reply nodes into the composer.
  // Stable deps: quoteReplyCtx is from context, composerRef is a ref.
  useEffect(() => {
    if (!quoteReplyCtx) return
    return quoteReplyCtx.registerHandler((data: QuoteReplyData) => {
      const quoteNode: JSONContent = {
        type: "quoteReply",
        attrs: {
          messageId: data.messageId,
          streamId: data.streamId,
          authorName: data.authorName,
          authorId: data.authorId,
          actorType: data.actorType,
          snippet: data.snippet,
        },
      }

      const currentContent = composerRef.current.content
      const existingBlocks = currentContent.content ?? []

      // Strip trailing empty paragraphs so the quote appends cleanly and we
      // re-add exactly one trailing paragraph for post-quote typing.
      const trimmedBlocks = [...existingBlocks]
      while (
        trimmedBlocks.length > 0 &&
        trimmedBlocks[trimmedBlocks.length - 1].type === "paragraph" &&
        (trimmedBlocks[trimmedBlocks.length - 1].content?.length ?? 0) === 0
      ) {
        trimmedBlocks.pop()
      }

      composerRef.current.setContent({
        type: "doc",
        content: [...trimmedBlocks, quoteNode, { type: "paragraph" }],
      })

      // Focus the composer so the user can start typing immediately
      composerFocusRef.current?.focusAfterQuoteReply()
    })
  }, [quoteReplyCtx])

  // Consume any pending share handoff for this stream, pre-inserting the
  // shared-message pointer into the composer and leaving the cursor after it.
  // We drive this through the editor directly (not React state) so the cursor
  // positioning lands atomically with the content change — going through the
  // useState path meant setContent committed one frame after the focus call,
  // and TipTap would reset the selection to 0 in the process.
  //
  // Two trigger paths: (a) on mount / streamId change, pick up any handoff
  // queued before this composer existed; (b) subscribe to the store so a
  // share queued while we're already mounted (e.g. share-to-parent fired
  // from a thread panel of the parent we're already viewing) reaches us
  // without a remount.
  useEffect(() => {
    let pendingRaf: number | null = null
    // Buffer of share nodes consumed from the store but not yet inserted
    // into the editor (editor not mounted, RAF retry pending). A second
    // handoff arriving mid-retry appends to this buffer and the RAF inserts
    // both in one chain — previously, cancelling the retry dropped the
    // first share's already-consumed payload from the closure. Order is
    // preserved: first queued ends up first in the doc.
    const buffered: JSONContent[] = []

    const cancelPendingRaf = () => {
      if (pendingRaf !== null) {
        cancelAnimationFrame(pendingRaf)
        pendingRaf = null
      }
    }

    const tryConsume = () => {
      const pending = consumeShareHandoff(streamId)
      if (pending) {
        buffered.push({
          type: "sharedMessage",
          attrs: pending as unknown as Record<string, unknown>,
        })
      }
      if (buffered.length === 0) return

      // Reset any in-flight retry — we'll restart it below covering the
      // updated buffer. Safe because the retry's only side-effect is
      // requestAnimationFrame; the editor write only happens inside
      // `insert()` which we re-run on the new RAF.
      cancelPendingRaf()

      const insert = (): boolean => {
        const editor = composerFocusRef.current?.getEditor?.()
        if (!editor || editor.isDestroyed) return false

        const currentDoc = editor.getJSON() as JSONContent
        const existingBlocks = currentDoc.content ?? []
        const trimmedBlocks = [...existingBlocks]
        while (
          trimmedBlocks.length > 0 &&
          trimmedBlocks[trimmedBlocks.length - 1].type === "paragraph" &&
          (trimmedBlocks[trimmedBlocks.length - 1].content?.length ?? 0) === 0
        ) {
          trimmedBlocks.pop()
        }

        // Drain the buffer atomically with the setContent so a notification
        // arriving between getJSON and setContent doesn't double-insert.
        const nodesToInsert = buffered.splice(0)
        editor
          .chain()
          .setContent({
            type: "doc",
            content: [...trimmedBlocks, ...nodesToInsert, { type: "paragraph" }],
          })
          .focus("end")
          .run()
        pendingRaf = null
        return true
      }

      if (insert()) return

      // Editor not mounted yet on the first tick after a route change —
      // retry on the next frame until it lands. Bound the chain with a
      // deadline so a permanently-unmounted host (e.g. the
      // `disabled && disabledReason` early return below) doesn't burn
      // a frame per tick forever and silently swallow the share. Mirrors
      // the deadline pattern on `triggerEditLast` further down.
      const deadline = performance.now() + 1500
      pendingRaf = requestAnimationFrame(function retry() {
        if (insert()) return
        if (performance.now() >= deadline) {
          pendingRaf = null
          return
        }
        pendingRaf = requestAnimationFrame(retry)
      })
    }

    tryConsume()
    const unsubscribe = subscribeShareHandoff(streamId, tryConsume)

    return () => {
      unsubscribe()
      cancelPendingRaf()
    }
  }, [streamId])

  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const messageSendMode = preferences?.messageSendMode ?? "enter"
  const isMobile = useIsMobile()
  const connectionState = useConnectionState()
  const isOffline = connectionState === "offline"

  // Resolve the portal target for the expanded overlay by walking up from our own DOM node
  // to the closest [data-editor-zone] ancestor. Works for both main stream view and thread panel.
  const selfRef = useRef<HTMLDivElement>(null)
  const expandedRef = useRef<HTMLDivElement>(null)
  const portalTargetRef = useRef<HTMLElement | null>(null)

  // Reset local state on stream change (e.g., draft promotion) without remounting
  useEffect(() => {
    setError(null)
    setExpanded(false)
  }, [streamId])

  // Collapse expanded overlay when viewport crosses to mobile (expand is desktop-only)
  useEffect(() => {
    if (isMobile) setExpanded(false)
  }, [isMobile])

  // Resolve the portal target lazily on expand to avoid silent blank screen
  // if the component mounts before the [data-editor-zone] ancestor exists.
  const handleExpandClick = useCallback(() => {
    portalTargetRef.current = selfRef.current?.closest<HTMLElement>("[data-editor-zone]") ?? null
    if (!portalTargetRef.current) {
      console.warn("MessageInput: no [data-editor-zone] ancestor found — expand disabled")
      return
    }
    setExpanded(true)
  }, [])
  const handleCollapse = useCallback(() => setExpanded(false), [])

  // Publish the floating composer's measured height so the scroll area can
  // reserve matching space (Virtuoso Footer, plain-scroll padding-bottom).
  // Disabled while the expanded overlay is open so the scroll area can use its
  // full height behind the overlay. `onHeightChange` lets the virtualized
  // timeline re-anchor to the bottom when the composer settles to a new height.
  useComposerHeightPublish(selfRef, { active: !expanded, onHeightChange: onComposerHeightChange })

  // Escape to close — only when focus is inside this expanded editor
  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key !== "Escape") return

      const expandedElement = expandedRef.current
      if (!expandedElement) return

      const activeElement = document.activeElement as HTMLElement | null
      const focusedEditor = activeElement?.closest<HTMLElement>('[contenteditable="true"]')
      if (focusedEditor && expandedElement.contains(focusedEditor)) return

      e.preventDefault()
      setExpanded(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [expanded])

  const handleSubmit = useCallback(
    async (editorContent?: JSONContent) => {
      if (!composer.canSend) return

      composer.setIsSending(true)
      setError(null)

      const pendingAttachments = composer.getPendingAttachmentsSnapshot()
      const liveContent = editorContent ?? composer.content
      const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)

      // Dispatch as a command only when the editor produced a slashCommand node.
      // Plain text starting with "/" (e.g. "/s") should send as a regular message.
      const commandNode = extractCommandNode(normalizedContent)
      if (commandNode !== null) {
        const { clientActionId } = commandNode

        // Clear input immediately for responsiveness — same reset the server
        // path does. Either branch below consumes the command, so the user
        // shouldn't see their chip linger after pressing send.
        composer.setContent(EMPTY_DOC)
        composer.clearDraft()
        setExpanded(false)

        // Client-action commands are routed locally — `/discuss-with-ariadne`
        // creates a scratchpad + navigates; no backend dispatch. Matches the
        // "type the command, press send" UX of server commands so the user
        // isn't surprised by an action firing as they pick from autocomplete.
        // The hook surfaces failure via a toast (shared with the context-menu
        // entry point), so we intentionally don't set an inline composer
        // error here — that would render the same failure twice.
        if (clientActionId === DISCUSS_WITH_ARIADNE_COMMAND) {
          try {
            await startDiscussWithAriadne({ sourceStreamId: streamId })
          } catch {
            /* hook already toasted; composer stays clean */
          } finally {
            composer.setIsSending(false)
          }
          return
        }

        const commandMarkdown = serializeToMarkdown(normalizedContent).trim()
        try {
          await queueCommand({ commandMarkdown, commandName: commandNode.name })
        } catch {
          setError("Failed to queue command. Please try again.")
        } finally {
          composer.setIsSending(false)
        }
        return
      }

      const attachments = extractUploadedAttachments(normalizedContent)
      const attachmentIds = attachments.map((attachment) => attachment.id)

      // Capture content before clearing
      const contentJson = liveContent

      try {
        // Clear the editor immediately so the composer does not briefly show the
        // just-sent content alongside the optimistic timeline event.
        // We keep the durable draft until send succeeds, so failures can still
        // restore the UI without losing content.
        composer.setContent(EMPTY_DOC)
        setExpanded(false)

        const result = await sendMessage({
          contentJson: normalizedContent,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        })

        composer.setContent(EMPTY_DOC)
        composer.clearDraft()
        composer.clearAttachments()
        if (result.navigateTo) {
          navigate(result.navigateTo, { replace: result.replace ?? false })
        }
      } catch {
        // This only happens for draft promotion failure (stream creation failed)
        // Real stream message failures are handled in the timeline with retry
        composer.setContent(contentJson)
        setError("Failed to create stream. Please try again.")
      } finally {
        composer.setIsSending(false)
      }
    },
    [composer, sendMessage, navigate, workspaceId, streamId, startDiscussWithAriadne, queueCommand]
  )

  /**
   * Schedule the current composer content for a future send. Mirrors the
   * happy-path of handleSubmit (materialize attachment refs, capture
   * attachments, clear the composer) but routes to the schedule API instead
   * of the live send pipeline. The schedule row appears immediately in the
   * Scheduled page via the upserted socket event.
   */
  const handleSchedule = useCallback(
    async (when: Date) => {
      if (!composer.canSend) return

      composer.setIsSending(true)
      setError(null)

      const pendingAttachments = composer.getPendingAttachmentsSnapshot()
      const liveContent = composer.content
      const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
      const attachments = extractUploadedAttachments(normalizedContent)
      const attachmentIds = attachments.map((a) => a.id)
      const contentMarkdown = serializeToMarkdown(normalizedContent)

      try {
        composer.setContent(EMPTY_DOC)
        setExpanded(false)
        await scheduleMessageMutation.mutateAsync({
          streamId,
          contentJson: normalizedContent,
          contentMarkdown,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          scheduledFor: when.toISOString(),
        })
        composer.clearDraft()
        composer.clearAttachments()
        toast.success("Scheduled")
      } catch (err) {
        composer.setContent(liveContent)
        const message = err instanceof Error ? err.message : "Could not schedule message"
        setError(message)
      } finally {
        composer.setIsSending(false)
      }
    },
    [composer, scheduleMessageMutation, streamId]
  )

  if (disabled && disabledReason) {
    // Use the same floating shell as the live composer so the banner anchors to
    // the bottom and publishes its height to `--composer-height` (via selfRef).
    // A plain in-flow div lands at the top of the absolutely-positioned stream
    // area and overlaps the first messages instead.
    return (
      <FloatingComposerShell ref={selfRef} data-message-composer-root>
        <div className="flex items-center justify-center py-3 px-4 rounded-md bg-muted/50">
          <p className="text-sm text-muted-foreground text-center">{disabledReason}</p>
        </div>
      </FloatingComposerShell>
    )
  }

  // Shared composer props used by both inline and expanded layouts
  const composerProps = {
    content: composer.content,
    onContentChange: composer.handleContentChange,
    pendingAttachments: composer.pendingAttachments,
    onRemoveAttachment: composer.handleRemoveAttachment,
    contextRefs: composer.contextRefs,
    streamId,
    workspaceId,
    fileInputRef: composer.fileInputRef,
    onFileSelect: composer.handleFileSelect,
    onFileUpload: composer.uploadFile,
    imageCount: composer.imageCount,
    onSubmit: handleSubmit,
    canSubmit: composer.canSend,
    isSubmitting: composer.isSending,
    hasFailed: composer.hasFailed,
    placeholder: isOffline ? "Type a message (sent when back online)" : undefined,
    messageSendMode,
    scopeId: streamId,
    onEditLastMessage: triggerEditLast
      ? () => {
          const unmountedId = triggerEditLast()
          if (!unmountedId) return
          // Message is in the loaded events but not mounted (virtualized out).
          // Ask the stream to scroll it into view — scrollToMessage walks
          // Virtuoso up to the right index and retries until the element lands
          // in the DOM. Poll triggerEditLast until the registry picks up the
          // newly-mounted message (or give up after ~1.2s).
          const scrolled = scrollToMessage?.(unmountedId) ?? false
          if (!scrolled) {
            // No virtualized scroller (non-virtualized path); fall back to
            // a best-effort DOM scroll so keyboard-edit still works.
            const el = document.querySelector(`[data-message-id="${CSS.escape(unmountedId)}"]`)
            el?.scrollIntoView({ block: "center" })
          }
          const deadline = performance.now() + 1200
          const retry = () => {
            if (triggerEditLast() === null) return
            if (performance.now() >= deadline) return
            setTimeout(retry, 60)
          }
          setTimeout(retry, 80)
        }
      : undefined,
    streamContext,
    composerRef: composerFocusRef,
    onStashDraft: stash.handleStashDraft,
    stashedDraftsTrigger: (
      <StashedDraftsPicker
        drafts={stash.drafts}
        canStashCurrent={composer.canSend}
        onStashCurrent={stash.handleStashDraft}
        onRestore={stash.handleRestoreStashed}
        onDelete={stash.handleDeleteStashed}
        controlsDisabled={composer.isSending}
      />
    ),
    stashedDraftsTriggerFab: (
      <StashedDraftsPicker
        drafts={stash.drafts}
        canStashCurrent={composer.canSend}
        onStashCurrent={stash.handleStashDraft}
        onRestore={stash.handleRestoreStashed}
        onDelete={stash.handleDeleteStashed}
        controlsDisabled={composer.isSending}
        size="fab"
      />
    ),
    scheduledMessagesTrigger: (
      <ScheduledMessagesPicker
        workspaceId={workspaceId}
        streamId={streamId}
        canSchedule={composer.canSend}
        onSchedule={handleSchedule}
        controlsDisabled={composer.isSending}
      />
    ),
    scheduledMessagesTriggerFab: (
      <ScheduledMessagesPicker
        workspaceId={workspaceId}
        streamId={streamId}
        canSchedule={composer.canSend}
        onSchedule={handleSchedule}
        controlsDisabled={composer.isSending}
        size="fab"
      />
    ),
  } as const

  return (
    <>
      {/* Expanded overlay — portaled into the stream view area */}
      {expanded &&
        portalTargetRef.current &&
        createPortal(
          <div ref={expandedRef} className="absolute inset-0 z-30 bg-background">
            <MessageComposer {...composerProps} expanded onCollapse={handleCollapse} autoFocus />
          </div>,
          portalTargetRef.current
        )}

      {/* Inline composer — hidden while expanded. Mobile inline editing is handled
          via CSS: `body:has([data-inline-edit])` matches whenever a MessageEditForm or
          UnsentMessageEditForm is mounted (including vaul drawer portals, which live
          under document.body), so the composer is hidden purely from DOM presence.
          This replaces a previous ref-counted React state mechanism that was prone to
          leaks across hydration races and virtualization cycles. */}
      <FloatingComposerShell ref={selfRef} hidden={expanded} data-message-composer-root>
        <ComposerEncryptionNotice workspaceId={workspaceId} encrypted={!!stream?.e2eEnabled} streamId={stream?.id} />
        {!expanded && <MessageComposer {...composerProps} autoFocus={autoFocus} onExpandClick={handleExpandClick} />}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </FloatingComposerShell>
    </>
  )
}
