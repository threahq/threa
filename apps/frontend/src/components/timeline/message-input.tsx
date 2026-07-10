import { memo, useState, useCallback, useEffect, useMemo, useRef } from "react"
import { createPortal } from "react-dom"
import { toast } from "sonner"
import { useNavigate } from "react-router-dom"
import {
  useDraftComposer,
  getDraftMessageKey,
  useStreamOrDraft,
  useComposerHeightPublish,
  useStashComposer,
  useDecryptedDraftPreviews,
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
import { useScheduleMessage, useStreamBootstrap } from "@/hooks"
import { useWorkspaceMetadata } from "@/stores/workspace-store"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { extractCommandNode, extractCommandFromRawText } from "@/lib/commands"
import { serializeToMarkdown, parseMarkdown } from "@threa/prosemirror"
import { useEditLastMessage } from "./edit-last-message-context"
import { useQuoteReply, appendQuoteReplyNode, type QuoteReplyData } from "./quote-reply-context"
import { useConversationReply, type ConversationReplyData } from "./conversation-reply-context"
import { useConversationBoardPost, boardPostLastActiveStreamId } from "@/hooks/use-conversations"
import { usePanel, createConversationPanelId } from "@/contexts"
import { Layers, X } from "lucide-react"
import { consumeShareHandoff, consumePlaintextShareHandoff, subscribeShareHandoff } from "@/stores/share-handoff-store"
import { consumeSnippetRequest, subscribeSnippetRequest } from "@/stores/snippet-request-store"
import { requestConversationReplyOpen } from "@/stores/conversation-reply-open-store"
import { useDiscussWithAriadne } from "@/hooks/use-discuss-with-ariadne"
import { useCommandDispatchQueue } from "@/hooks/use-command-dispatch-queue"
import { DISCUSS_WITH_ARIADNE_COMMAND, type JSONContent, type CommandInfo } from "@threa/types"
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
   * measurement differs from the persisted inset the list first painted with).
   * The timeline uses this to re-anchor to the bottom so the last message isn't
   * left covered by a composer that settled taller. `opts.initial`
   * marks the pre-paint first measurement so the timeline can correct it
   * synchronously instead of debouncing.
   */
  onComposerHeightChange?: (px: number, opts: { initial: boolean }) => void
}

function attachmentMatchKey(attachment: Pick<PendingAttachment, "filename" | "mimeType">): string {
  return `${attachment.filename}::${attachment.mimeType}`
}

export function extractUploadedAttachments(
  content: JSONContent,
  // Node attrs always persist `status: "uploaded"` (stored contentJson is
  // immutable — nothing revisits it when bytes land), so live upload state for
  // the optimistic summary comes from the composer's pending snapshot instead.
  pendingAttachments: PendingAttachment[] = []
): Array<{
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  uploadStatus?: "reserved" | "uploading" | "uploaded" | "failed" | "abandoned"
}> {
  const attachments = new Map<
    string,
    {
      id: string
      filename: string
      mimeType: string
      sizeBytes: number
      uploadStatus?: "reserved" | "uploading" | "uploaded" | "failed" | "abandoned"
    }
  >()
  const stillUploading = new Set(pendingAttachments.filter((a) => a.status === "uploading").map((a) => a.id))

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
        ...(stillUploading.has(node.attrs.id) && { uploadStatus: "uploading" as const }),
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
    if (attachment.status === "error" || attachment.id.startsWith("temp_")) continue
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
            // Persisted contentJson always says "uploaded": stored message
            // content is never revisited when bytes land, so a transient
            // "uploading" here would freeze a spinner into the message forever
            // and drop the attachment from content_markdown (the serializer
            // skips uploading nodes). Live upload state rides the message's
            // attachment summaries instead.
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

  // Resolve the effective command list for this stream so raw-text slash
  // commands (e.g. `/model ` with a trailing space) can be dispatched even
  // when the editor did not materialize a `slashCommand` node.
  const metadata = useWorkspaceMetadata(workspaceId)
  const { data: streamBootstrap } = useStreamBootstrap(workspaceId, streamId, { enabled: false })
  const availableCommands = useMemo<CommandInfo[]>(() => {
    return streamBootstrap?.commands ?? metadata?.commands ?? []
  }, [streamBootstrap?.commands, metadata?.commands])
  const availableCommandByName = useMemo(() => {
    const map = new Map<string, CommandInfo>()
    for (const cmd of availableCommands) {
      map.set(cmd.name.toLowerCase(), cmd)
    }
    return map
  }, [availableCommands])

  // Broadcast/mention filtering, member/bot allow-lists, and the admin gate
  // for bot invites all live in `useMentionStreamContext`. Threads route
  // through their root channel for access grants — handled inside the hook.
  const streamContext = useMentionStreamContext(workspaceId, stream)

  const e2eEnabled = stream?.e2eEnabled === true
  // The encrypted root holds the SSK + wraps (a thread shares its root's key), so
  // both sealing and the repair notice key off the root, not the (maybe-thread) id.
  const e2eRootStreamId = e2eEnabled ? (stream?.rootStreamId ?? streamId) : undefined
  const composer = useDraftComposer({
    workspaceId,
    draftKey,
    scopeId: streamId,
    e2eStreamId: e2eRootStreamId,
  })
  const quoteReplyCtx = useQuoteReply()

  // Stashed drafts — explicit "Save for later" pile scoped to this stream.
  // Active DraftMessage stays one-per-scope; this hook manages the sibling
  // many-per-scope stash and the `?stash=<id>` URL auto-restore. Stash + restore
  // are pointer moves, so they work for plaintext and E2E alike (no gating).
  const stash = useStashComposer(composer, workspaceId, draftKey)
  // Decrypt-on-read previews for the stash pile (sealed rows decrypt via the
  // shared cache; plaintext rows resolve from contentJson). All entries share
  // this stream's encrypted root.
  const stashPreviewInputs = useMemo(
    () => stash.drafts.map((draft) => ({ draft, rootStreamId: e2eRootStreamId })),
    [stash.drafts, e2eRootStreamId]
  )
  const stashPreviews = useDecryptedDraftPreviews(workspaceId, stashPreviewInputs)

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
      composerRef.current.setContent(appendQuoteReplyNode(composerRef.current.content, data))
      composerFocusRef.current?.focusAfterQuoteReply()
    })
  }, [quoteReplyCtx])

  // "Reply in conversation" (Mechanism C): the armed conversation rides the send
  // as an `existing` directive — nothing is inserted into the body. Held as
  // in-memory state (not part of the durable draft): a stale filing surviving a
  // reload would silently misfile whatever is typed next, so it resets with the
  // session and with the stream.
  const conversationReplyCtx = useConversationReply()
  const { openPanel } = usePanel()
  const [conversationReply, setConversationReply] = useState<ConversationReplyData | null>(null)
  useEffect(() => {
    if (!conversationReplyCtx) return
    // Arm only. Focus is deferred to the resolve effect below: focusing the
    // channel composer here would pop the mobile keyboard on it a beat before a
    // thread-follow reply redirects to the conversation panel.
    return conversationReplyCtx.registerHandler((data: ConversationReplyData) => {
      setConversationReply(data)
    })
  }, [conversationReplyCtx])
  useEffect(() => {
    setConversationReply(null)
  }, [streamId])
  // Topic label for the strip — cached board card or a one-shot by-id fetch. The
  // same projection carries the conversation's most-recently-active stream: the
  // latest reply's own stream (a thread under the root), falling back to the
  // conversation's anchor.
  const { post: conversationReplyPost } = useConversationBoardPost(
    workspaceId,
    conversationReply?.conversationId ?? null
  )
  const conversationReplyTopic = conversationReplyPost?.conversation.topicSummary ?? null
  const conversationReplyLastActiveStreamId = conversationReplyPost
    ? boardPostLastActiveStreamId(conversationReplyPost)
    : null

  // Hand the armed conversation off to its side panel (Mechanism B), which renders
  // it across its root + threads and routes the reply recency-biased into the live
  // thread. Shared by the resolve effect (proactive, once the projection loads) and
  // the send guard (the race where the user sends before it loads).
  const redirectReplyToPanel = useCallback(
    (conversationId: string) => {
      requestConversationReplyOpen(conversationId)
      openPanel(createConversationPanelId(conversationId))
      setConversationReply(null)
    },
    [openPanel]
  )

  // Current stream read through a ref so the routing effect doesn't take `streamId`
  // as a dep: on a plain stream switch, `streamId` changes while `conversationReply`
  // still holds the previous stream's armed value (the `[streamId]` reset effect
  // hasn't committed yet), and a streamId-driven re-run would misread that as a
  // thread-follow and spuriously open the panel. The reset effect nulls the arm,
  // which re-runs this effect to a clean no-op.
  const streamIdRef = useRef(streamId)
  streamIdRef.current = streamId

  // Thread-follow: route the armed reply ONCE, at first resolution of the
  // projection. A conversation live in THIS stream keeps the inline strip and
  // focuses the composer to type; one that has moved into a thread hands off to
  // the panel — a flat send there would re-interleave the channel, the mess
  // recency-biased continuation avoids (board-view-design.md).
  //
  // The route is latched per arm (`routedArmIdRef`): `conversationReplyLastActive-
  // StreamId` is a live Dexie value, so without the latch a background reply that
  // later moves the conversation into a thread would re-fire this effect and evict
  // the user from the channel mid-composition, unsolicited. Once routed, only an
  // explicit send re-checks routing. The latch resets when the arm is cleared.
  const routedArmIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!conversationReply) {
      routedArmIdRef.current = null
      return
    }
    if (routedArmIdRef.current === conversationReply.conversationId) return
    const target = conversationReplyLastActiveStreamId
    if (!target) return
    routedArmIdRef.current = conversationReply.conversationId
    if (target === streamIdRef.current) composerFocusRef.current?.focus()
    else redirectReplyToPanel(conversationReply.conversationId)
  }, [conversationReply, conversationReplyLastActiveStreamId, redirectReplyToPanel])

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
      // A message shared OUT of an E2E scratchpad: the decrypted plaintext was
      // captured (behind a confirmation) and is inserted as a public blockquote,
      // not a sealed pointer recipients couldn't open.
      const pendingPlaintext = consumePlaintextShareHandoff(streamId)
      if (pendingPlaintext) {
        const parsed = parseMarkdown(pendingPlaintext.markdown)
        const inner = parsed.content && parsed.content.length > 0 ? parsed.content : [{ type: "paragraph" }]
        buffered.push({ type: "blockquote", content: inner })
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

  // Open the snippet editor when the command palette requests one for this
  // stream. Same hand-off shape as shares: consume on mount (request queued
  // before this composer existed) and subscribe so a request fired while we're
  // mounted reaches us without a remount.
  useEffect(() => {
    const open = () => composerFocusRef.current?.openSnippetEditor()
    if (consumeSnippetRequest(streamId)) open()
    return subscribeSnippetRequest(streamId, () => {
      if (consumeSnippetRequest(streamId)) open()
    })
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
  // dock above it instead of relying on in-content bottom padding.
  // Disabled while the expanded overlay is open so the scroll area can use its
  // full height behind the overlay. `onHeightChange` lets the timeline
  // re-anchor to the bottom when the composer settles to a new height.
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

      // Dispatch as a command when the editor produced a slashCommand node,
      // or when the message is raw text that matches an available slash command
      // (e.g. `/model ` with a trailing space that never became a node). Plain
      // text like "/s" that does not match a known command still sends normally.
      const commandNode = extractCommandNode(normalizedContent)
      const rawTextCommand = commandNode === null ? extractCommandFromRawText(normalizedContent) : null
      const resolvedCommand =
        commandNode ?? (rawTextCommand ? (availableCommandByName.get(rawTextCommand.name) ?? null) : null)
      if (resolvedCommand !== null) {
        const commandName = commandNode?.name ?? rawTextCommand!.name
        const clientActionId = commandNode?.clientActionId ?? resolvedCommand.clientActionId ?? null

        // Clear input immediately for responsiveness — same reset the server
        // path does. Either branch below consumes the command, so the user
        // shouldn't see their chip linger after pressing send.
        composer.setContent(EMPTY_DOC)
        composer.resolveDraft()
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
            await startDiscussWithAriadne({ kind: "thread", sourceStreamId: streamId })
          } catch {
            /* hook already toasted; composer stays clean */
          } finally {
            composer.setIsSending(false)
          }
          return
        }

        const commandMarkdown = rawTextCommand
          ? `/${commandName}${rawTextCommand.args ? ` ${rawTextCommand.args}` : ""}`
          : serializeToMarkdown(normalizedContent).trim()
        try {
          await queueCommand({ commandMarkdown, commandName })
        } catch {
          setError("Failed to queue command. Please try again.")
        } finally {
          composer.setIsSending(false)
        }
        return
      }

      // Armed for "Reply in conversation" but not confirmed live in THIS stream
      // (thread-live, or the board-post projection hasn't resolved yet): filing
      // flat here would re-interleave the channel. Hand off to the conversation
      // panel and keep the composer content — nothing typed is lost, the user
      // continues in the panel. The inline flat send below only runs once the
      // conversation is confirmed same-stream. A toast because the send didn't do
      // the obvious thing (post here): the panel can cover this view on mobile, so
      // the kept draft needs a word or the message reads as vanished (INV-63:
      // deferred action, no other on-screen signal).
      if (conversationReply && conversationReplyLastActiveStreamId !== streamId) {
        redirectReplyToPanel(conversationReply.conversationId)
        toast.info("Opening the conversation to reply — your draft was kept here.")
        composer.setIsSending(false)
        return
      }

      const attachments = extractUploadedAttachments(normalizedContent, pendingAttachments)
      const attachmentIds = attachments.map((attachment) => attachment.id)

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
          // Armed by "Reply in conversation": file this send into the
          // conversation synchronously (Mechanism C). Cleared only on success —
          // a failed send keeps the filing armed alongside the restored content.
          conversation: conversationReply
            ? { intent: "existing", conversationId: conversationReply.conversationId }
            : undefined,
        })

        setConversationReply(null)
        composer.setContent(EMPTY_DOC)
        composer.resolveDraft()
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
    [
      composer,
      sendMessage,
      navigate,
      workspaceId,
      streamId,
      startDiscussWithAriadne,
      queueCommand,
      availableCommandByName,
      conversationReply,
      conversationReplyLastActiveStreamId,
      redirectReplyToPanel,
    ]
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
      const attachments = extractUploadedAttachments(normalizedContent, pendingAttachments)
      const attachmentIds = attachments.map((a) => a.id)

      // A live send whose conversation has drifted into a thread hands off to the
      // panel (handleSubmit above). A scheduled send can't — there's no live thread
      // at fire time and the picker has no panel affordance — so it always files by
      // id. Surface that divergence when armed-and-drifted so the deferred reply
      // doesn't read as a flat channel send (INV-63: deferred action, no other
      // on-screen signal). Same-stream stays silent (the strip already shows it).
      const filesIntoDriftedConversation =
        conversationReply !== null && conversationReplyLastActiveStreamId !== streamId

      try {
        composer.setContent(EMPTY_DOC)
        setExpanded(false)
        await scheduleMessageMutation.mutateAsync({
          streamId,
          contentJson: normalizedContent,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          scheduledFor: when.toISOString(),
          // Armed by "Reply in conversation": the directive rides the scheduled
          // row and is forwarded to the send at fire time, so a scheduled reply
          // files into its conversation exactly as an immediate send would.
          // Unlike the live send there's no thread-follow routing — the fired
          // message posts into this stream and the assigner attaches it to the
          // conversation by id (cross-stream within one root is allowed).
          conversation: conversationReply
            ? { intent: "existing", conversationId: conversationReply.conversationId }
            : undefined,
        })
        setConversationReply(null)
        composer.resolveDraft()
        composer.clearAttachments()
        if (filesIntoDriftedConversation) {
          toast.info("Scheduled — this reply will file into the conversation when it sends.")
        }
      } catch (err) {
        composer.setContent(liveContent)
        const message = err instanceof Error ? err.message : "Could not schedule message"
        setError(message)
      } finally {
        composer.setIsSending(false)
      }
    },
    [composer, scheduleMessageMutation, streamId, conversationReply, conversationReplyLastActiveStreamId]
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

  // While an unlocked E2E draft's sealed body decrypts into the composer, signal
  // it in the placeholder so the briefly-empty editor doesn't read as "no draft";
  // a failed decrypt says so plainly instead of leaving a permanent spinner.
  const offlinePlaceholder = isOffline ? "Type a message (sent when back online)" : undefined
  let composerPlaceholder = offlinePlaceholder
  if (composer.decryptFailed) composerPlaceholder = "Couldn't decrypt your saved draft"
  else if (composer.isDecrypting) composerPlaceholder = "Decrypting your draft…"

  // Shared composer props used by both inline and expanded layouts
  const composerProps = {
    content: composer.content,
    onContentChange: composer.handleContentChange,
    pendingAttachments: composer.pendingAttachments,
    onRemoveAttachment: composer.handleRemoveAttachment,
    onCancelAttachmentUpload: composer.handleCancelAttachmentUpload,
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
    placeholder: composerPlaceholder,
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
        previewById={stashPreviews}
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
        previewById={stashPreviews}
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

  // Armed "Reply in conversation" strip — the send's only signal that it will
  // file into a conversation, so it renders wherever the composer does (inline
  // and expanded). Dismissible: X disarms without touching the typed content.
  const conversationReplyStrip = conversationReply ? (
    <div
      data-testid="conversation-reply-strip"
      className="mb-1.5 flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
    >
      <Layers className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        Replying in <span className="font-medium">{conversationReplyTopic ?? "conversation"}</span>
      </span>
      <button
        type="button"
        aria-label="Cancel reply in conversation"
        onClick={() => setConversationReply(null)}
        className="ml-auto shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null

  return (
    <>
      {/* Expanded overlay — portaled into the stream view area */}
      {expanded &&
        portalTargetRef.current &&
        createPortal(
          <div ref={expandedRef} className="absolute inset-0 z-30 flex flex-col bg-background">
            {conversationReplyStrip}
            <div className="min-h-0 flex-1">
              <MessageComposer {...composerProps} expanded onCollapse={handleCollapse} autoFocus />
            </div>
          </div>,
          portalTargetRef.current
        )}

      {/* Inline composer — hidden while expanded. Mobile inline editing hides the
          composer via the body-level inline-edit presence attribute. */}
      <FloatingComposerShell ref={selfRef} hidden={expanded} data-message-composer-root>
        <ComposerEncryptionNotice workspaceId={workspaceId} encrypted={e2eEnabled} streamId={e2eRootStreamId} />
        {!expanded && conversationReplyStrip}
        {!expanded && <MessageComposer {...composerProps} autoFocus={autoFocus} onExpandClick={handleExpandClick} />}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </FloatingComposerShell>
    </>
  )
}
