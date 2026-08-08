import { memo, useState, useCallback, useEffect, useMemo, useRef } from "react"
import { toast } from "sonner"
import { useNavigate } from "react-router-dom"
import {
  hasDocContent,
  useDraftComposer,
  getDraftMessageKey,
  useStreamOrDraft,
  useComposerHeightPublish,
  useStashComposer,
  useStashParamDraftRow,
  useDecryptedDraftPreviews,
  useStashedDraftOrigins,
  useMentionStreamContext,
  useComposerTarget,
  useMountedComposerCount,
  clearComposerTarget,
} from "@/hooks"
import { useIsMobile } from "@/hooks/use-mobile"
import { relocateLoadedDraft, stashLoadedDraft } from "@/hooks/use-draft-message"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { useComposeTrace } from "@/lib/compose-trace"
import { usePreferences } from "@/contexts"
import { useConnectionState } from "@/components/layout/connection-status"
import {
  ConversationReplyStrip,
  ConversationReplyStripPlaceholder,
  FloatingComposerShell,
  ComposerDisabledNotice,
  MessageComposer,
  OverlayComposerShell,
  ScheduledMessagesPicker,
  StashedDraftsPicker,
} from "@/components/composer"
import type { ComposerControlHandle } from "@/components/composer"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS } from "@/lib/streams"
import { useScheduleMessage } from "@/hooks"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { parseMarkdown } from "@threa/prosemirror"
import { useEditLastMessage } from "./edit-last-message-context"
import { useQuoteReply, appendQuoteReplyNode, type QuoteReplyData } from "./quote-reply-context"
import { useConversationReply, type ConversationReplyData } from "./conversation-reply-context"
import { useConversationBoardPost } from "@/hooks/use-conversations"
import { boardPostLastActiveStreamId } from "@/lib/board/reply-plan"
import { boardReplyDraftKey, parseBoardDraftKey } from "@/lib/board/draft-keys"
import { usePanel, createConversationPanelId } from "@/contexts"
import { consumeShareHandoff, consumePlaintextShareHandoff, subscribeShareHandoff } from "@/stores/share-handoff-store"
import { consumeSnippetRequest, subscribeSnippetRequest } from "@/stores/snippet-request-store"
import { requestConversationReplyOpen } from "@/stores/conversation-reply-open-store"
import { useComposerCommandSend } from "@/components/composer/use-composer-command-send"
import type { JSONContent } from "@threa/types"
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
    // Reserved-but-still-uploading attachments materialize like uploaded ones
    // (send-while-uploading): their id is real and the message binds it while
    // the bytes finish. The node's persisted status is always "uploaded" —
    // stored contentJson is never revisited when the upload settles, so a
    // baked-in "uploading" would spin forever and be dropped from
    // content_markdown (the serializer skips uploading nodes). Live upload
    // state rides the message's attachment summaries instead. Errors and
    // still-reserving (temp-id) files stay out of the message.
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
  const scheduleMessageMutation = useScheduleMessage(workspaceId)
  const hostScope = getDraftMessageKey({ type: "stream", streamId })

  // Send-time command routing (raw-text `/model ` included, even when the editor
  // never materialized a `slashCommand` node), over the same effective command
  // list the `/` palette reads.
  const { planSend, dispatchCommand } = useComposerCommandSend(workspaceId, streamId)

  // Broadcast/mention filtering, member/bot allow-lists, and the admin gate
  // for bot invites all live in `useMentionStreamContext`. Threads route
  // through their root channel for access grants — handled inside the hook.
  const streamContext = useMentionStreamContext(workspaceId, stream)

  const isMobile = useIsMobile()
  const e2eEnabled = stream?.e2eEnabled === true
  // The encrypted root holds the SSK + wraps (a thread shares its root's key), so
  // both sealing and the repair notice key off the root, not the (maybe-thread) id.
  const e2eRootStreamId = e2eEnabled ? (stream?.rootStreamId ?? streamId) : undefined

  // "Reply in conversation" (Mechanism C) points this host at the conversation's
  // own draft scope, durably (`composerTarget`). The composer then edits THAT
  // draft: the arm is which draft is open, not a flag riding whatever is typed
  // next, so it survives a reload and the strip renders straight from it.
  const { scope: storedTarget, isResolved: targetResolved } = useComposerTarget(hostScope)
  const parsedTarget = storedTarget ? parseBoardDraftKey(storedTarget) : null
  const targetConversationId =
    parsedTarget && (parsedTarget.kind === "reply" || parsedTarget.kind === "branch-reply")
      ? parsedTarget.conversationId
      : null
  // Topic label for the strip — cached board card or a one-shot by-id fetch. The
  // same projection carries the conversation's most-recently-active stream: the
  // latest reply's own stream (a thread under the root), falling back to the
  // conversation's anchor.
  const { post: conversationReplyPost, notFound: conversationReplyNotFound } = useConversationBoardPost(
    workspaceId,
    targetConversationId
  )
  // Never apply the target on an encrypted stream: a board draft is plaintext at
  // rest, and this composer purges the plaintext drafts of whatever scope it
  // holds (E2EE-4). `e2eEnabled` and `draftKey` derive from the same `stream`
  // value in one render, so a late resolve flips both together and the purge can
  // never see a board scope. An unresolvable target (an unparseable scope, or a
  // conversation the server says is gone) falls back to the host's own scope
  // rather than leaving the composer pointed at nothing (INV-11 — report it,
  // don't strand the user).
  //
  // Only a 404 counts as gone. A failed request (`loadFailed`) must HOLD the arm:
  // clearing on any error would yank the composer's scope out from under whatever
  // is being typed, on one 502, irreversibly.
  const targetUnresolvable = (storedTarget !== null && !targetConversationId) || conversationReplyNotFound

  // Which arm came from the gesture in this session, and on which host. The
  // target is durable, so "armed" alone can no longer tell a deliberate act from
  // a page load — and the host is part of it because this component is NOT
  // remounted per stream: without it, arming in stream A and navigating back to
  // A (or onto a B that is armed for the same conversation) would read as a
  // fresh gesture and route on a plain navigation.
  const gestureArmedIdRef = useRef<{ host: string; conversationId: string } | null>(null)

  // Disarm: this composer stops pointing at the conversation and reverts to the
  // stream's own draft. The typed draft is NOT moved — its scope IS its target,
  // so it stays a draft of that conversation and keeps its filing.
  //
  // It must also stop being CHECKED OUT here. A draft loaded under a scope no
  // composer is showing is excluded from every pile on the device (the
  // checked-out-anywhere rule) and carries no `?stash=` link in the explorer, so
  // "it stays reachable" would be false — the only way back would be to open that
  // conversation. Detaching the pointer turns it into a real stash entry, which
  // is what makes that sentence true. Unless another composer is already mounted
  // on the scope: then it is showing the draft and owns it.
  //
  // ONE disarm, for every path that drops the target: clearing the target alone
  // strands the gesture latch, and a stranded latch makes the NEXT arm read as a
  // fresh gesture — which redirects to the panel and wipes the target that arm
  // just set. The ref is cleared here rather than in the routing effect because
  // the gesture sets it synchronously while the target lands an IDB write later:
  // an effect re-run in that window would erase the very gesture it recognises.
  // Read through refs: `disarmTarget` is handed to `useStashComposer`, so a new
  // identity on every target change would churn its callbacks for nothing.
  const effectiveTargetRef = useRef<string | null>(null)
  const mountedOnTargetRef = useRef(0)
  const disarmTarget = useCallback(async () => {
    gestureArmedIdRef.current = null
    const vacated = effectiveTargetRef.current
    await clearComposerTarget(hostScope)
    if (!vacated || mountedOnTargetRef.current > 1) return
    try {
      await composerRef.current.flushDraft()
    } catch (err) {
      console.error("[composer] flush before disarm failed", err)
    }
    try {
      await stashLoadedDraft(workspaceId, vacated)
    } catch (err) {
      console.error("[composer] could not release the disarmed draft", err)
    }
  }, [hostScope, workspaceId])
  const disarm = useCallback(() => {
    void disarmTarget()
  }, [disarmTarget])

  useEffect(() => {
    if (!targetUnresolvable) return
    console.error(`[composer] dropping unresolvable target for ${hostScope}: ${storedTarget}`)
    disarm()
  }, [targetUnresolvable, hostScope, storedTarget, disarm])
  const effectiveTarget =
    targetResolved && !e2eEnabled && targetConversationId && !targetUnresolvable ? storedTarget : null
  // Includes this composer once it is pointed at the scope, so >1 means someone else.
  const mountedOnTarget = useMountedComposerCount(workspaceId, effectiveTarget)
  effectiveTargetRef.current = effectiveTarget
  mountedOnTargetRef.current = mountedOnTarget
  const armedConversationId = effectiveTarget ? targetConversationId : null
  const conversationReplyTopic = conversationReplyPost?.conversation.topicSummary ?? null
  const conversationReplyLastActiveStreamId = conversationReplyPost
    ? boardPostLastActiveStreamId(conversationReplyPost)
    : null

  // The draft scope this composer edits — the target when armed, the stream's own
  // otherwise. `scopeId` MUST follow it: the composer's rehydrate keys on
  // `scopeId` (`use-draft-composer.ts`), so a mismatched pair renders one draft
  // while every save targets another.
  const draftKey = effectiveTarget ?? hostScope
  const syncEngine = useOptionalSyncEngine()
  const composer = useDraftComposer({
    workspaceId,
    draftKey,
    scopeId: draftKey,
    e2eStreamId: e2eRootStreamId,
  })
  const quoteReplyCtx = useQuoteReply()

  // Stashed drafts — explicit "Save for later" pile scoped to this stream.
  // Active DraftMessage stays one-per-scope; this hook manages the sibling
  // many-per-scope stash and the `?stash=<id>` URL auto-restore. Stash + restore
  // are pointer moves, so they work for plaintext and E2E alike (no gating).
  // `targetHost` is what makes ADOPT reachable here: this is the one composer
  // that can point itself at another scope, so restoring a conversation's draft
  // keeps the row where it is and raises the strip instead of moving it.
  const stash = useStashComposer(composer, workspaceId, draftKey, { targetHost: hostScope, disarmTarget })
  // A `?stash=` deep link naming one of THIS stream's own stashed rows while the
  // composer is armed: the stash host is the board scope, so nobody would claim
  // the param and the URL would carry it forever. Disarm — an explicit "work on
  // this one" outranks the arm — and the restore proceeds on the next render.
  // Not by pointing the stash host back at `hostScope`: `handleStashDraft` would
  // then flush the composer's board content and detach the stream scope's
  // pointer, stashing the wrong draft.
  const stashParamRow = useStashParamDraftRow(workspaceId)
  const stashParamWantsHostScope = !!effectiveTarget && stashParamRow?.scope === hostScope
  // Decrypt-on-read previews for the stash pile (sealed rows decrypt via the
  // shared cache; plaintext rows resolve from contentJson). All entries share
  // this stream's encrypted root.
  const stashPreviewInputs = useMemo(
    () => stash.drafts.map((draft) => ({ draft, rootStreamId: e2eRootStreamId })),
    [stash.drafts, e2eRootStreamId]
  )
  const stashPreviews = useDecryptedDraftPreviews(workspaceId, stashPreviewInputs)
  const stashOrigins = useStashedDraftOrigins(workspaceId, stash.originByDraftId)

  // Use a ref so the handler always reads fresh composer state without
  // re-registering on every render (composer object is not memoized).
  const composerRef = useRef(composer)
  const armConversationPendingRef = useRef(false)
  const removeConversationFilingPendingRef = useRef(false)
  const mobileChromeOpenRef = useRef(false)
  const [preserveConversationStripSpace, setPreserveConversationStripSpace] = useState(false)
  composerRef.current = composer

  // Imperative handle for programmatic focus from outside (e.g. quote reply insertion)
  const composerFocusRef = useRef<ComposerControlHandle | null>(null)

  const { onComposerFocus, takeComposeTrace } = useComposeTrace({
    workspaceId,
    scopeId: streamId,
    horizonStreamId: streamId,
    hasDraftContent: () => hasDocContent(composerRef.current.content),
    draftReady: composer.isLoaded,
  })

  // Register with QuoteReplyContext to insert quote reply nodes into the composer.
  // Stable deps: quoteReplyCtx is from context, composerRef is a ref.
  useEffect(() => {
    if (!quoteReplyCtx) return
    return quoteReplyCtx.registerHandler((data: QuoteReplyData) => {
      composerRef.current.setContent(appendQuoteReplyNode(composerRef.current.content, data))
      composerFocusRef.current?.focusAfterQuoteReply()
    })
  }, [quoteReplyCtx])

  // "Reply in conversation" changes the filing of the content already in this
  // mounted editor. Flush it, move that same draft row, and update the durable
  // target in one local-first transaction. An empty composer with no row simply
  // opens the destination's existing draft, if any.
  const conversationReplyCtx = useConversationReply()
  const { openPanel } = usePanel()
  useEffect(() => {
    if (!conversationReplyCtx) return
    return conversationReplyCtx.registerHandler((data: ConversationReplyData) => {
      if (armConversationPendingRef.current) return
      armConversationPendingRef.current = true
      gestureArmedIdRef.current = { host: hostScope, conversationId: data.conversationId }
      const targetScope = boardReplyDraftKey(data.conversationId)
      void (async () => {
        try {
          await composerRef.current.flushDraft({ keepEmpty: true })
          await relocateLoadedDraft(workspaceId, draftKey, targetScope, { targetHost: hostScope })
          syncEngine?.kickOperationQueue()
        } catch (err) {
          gestureArmedIdRef.current = null
          console.error("[composer] could not change the conversation filing", err)
        } finally {
          armConversationPendingRef.current = false
        }
      })()
    })
  }, [conversationReplyCtx, workspaceId, hostScope, draftKey, syncEngine])

  const removeConversationFiling = useCallback(async () => {
    const vacated = effectiveTarget
    if (!vacated || removeConversationFilingPendingRef.current) return
    removeConversationFilingPendingRef.current = true
    try {
      // The editor owns the payload. Persist it, then move that same row's filing
      // metadata and durable target together; no identity hand-off occurs.
      await composerRef.current.flushDraft({ keepEmpty: true })
      await relocateLoadedDraft(workspaceId, vacated, hostScope, { targetHost: hostScope })
      gestureArmedIdRef.current = null
      syncEngine?.kickOperationQueue()
    } catch (err) {
      setPreserveConversationStripSpace(false)
      console.error("[composer] could not remove the conversation filing", err)
    } finally {
      removeConversationFilingPendingRef.current = false
    }
  }, [effectiveTarget, workspaceId, hostScope, syncEngine])

  const dismissConversationFiling = useCallback(() => {
    // Keep the focused mobile shell still until its keyboard/chrome session ends.
    setPreserveConversationStripSpace(isMobile && mobileChromeOpenRef.current)
    void removeConversationFiling()
  }, [isMobile, removeConversationFiling])

  const handleMobileChromeOpenChange = useCallback((open: boolean) => {
    mobileChromeOpenRef.current = open
    if (!open) setPreserveConversationStripSpace(false)
  }, [])

  useEffect(() => {
    if (stashParamWantsHostScope) disarm()
  }, [stashParamWantsHostScope, disarm])

  // Two live editors on one draft row is the failure the mounted-composer registry
  // exists to police: the second never re-reads an ordinary body change, so
  // whichever saves last silently wins. Arming let this composer occupy a board
  // scope the conversation panel also mounts, so when the panel opens, yield —
  // it is the more specific host, the same precedence the panel hand-off already
  // uses, and the draft is checked out at that scope so it lands there intact.
  useEffect(() => {
    if (!effectiveTarget || mountedOnTarget <= 1) return
    gestureArmedIdRef.current = null
    void clearComposerTarget(hostScope)
  }, [effectiveTarget, mountedOnTarget, hostScope])

  // Hand the armed conversation off to its side panel (Mechanism B), which renders
  // it across its root + threads and routes the reply recency-biased into the live
  // thread. Shared by the resolve effect (proactive, once the projection loads) and
  // the send guard (the race where the user sends before it loads). The draft stays
  // at the conversation's scope, which is the scope the panel's composer opens.
  const redirectReplyToPanel = useCallback(
    (conversationId: string) => {
      requestConversationReplyOpen(conversationId)
      openPanel(createConversationPanelId(conversationId))
      disarm()
    },
    [openPanel, disarm]
  )

  // Thread-follow: route the armed reply ONCE, at first resolution of the
  // projection, and only for an arm the user just made. A restored arm is a page
  // load, not a gesture: routing it would open the side panel over the channel
  // the user navigated to (or pop the mobile keyboard) with no action behind it.
  // A conversation live in THIS stream keeps the inline strip and
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
    if (!armedConversationId) {
      routedArmIdRef.current = null
      return
    }
    if (routedArmIdRef.current === armedConversationId) return
    // Restored, not gestured: latch it as routed so it shows the strip and does
    // nothing else. The send guard still routes when the user actually sends.
    const gesture = gestureArmedIdRef.current
    if (gesture?.host !== hostScope || gesture.conversationId !== armedConversationId) {
      routedArmIdRef.current = armedConversationId
      return
    }
    const target = conversationReplyLastActiveStreamId
    if (!target) return
    routedArmIdRef.current = armedConversationId
    // A gesture routes ONCE. `routedArmIdRef` is reset whenever the arm goes
    // away (a stream switch does that), so without consuming the gesture here,
    // navigating back would re-read it as a fresh gesture and route again on a
    // plain navigation.
    gestureArmedIdRef.current = null
    if (target === streamId) composerFocusRef.current?.focus()
    else redirectReplyToPanel(armedConversationId)
  }, [armedConversationId, conversationReplyLastActiveStreamId, redirectReplyToPanel, streamId, hostScope])

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
  const connectionState = useConnectionState()
  const isOffline = connectionState === "offline"

  const composerHeightRef = useComposerHeightPublish({
    active: !expanded,
    onHeightChange: onComposerHeightChange,
  })

  // Reset local state on stream change (e.g., draft promotion) without remounting
  useEffect(() => {
    setError(null)
    setExpanded(false)
    setPreserveConversationStripSpace(false)
  }, [streamId])

  // Collapse the fullscreen overlay when the viewport crosses to mobile (expand is
  // a desktop affordance; mobile authors long messages via the mobile-expanded chrome).
  useEffect(() => {
    if (isMobile) setExpanded(false)
  }, [isMobile])

  const handleExpandClick = useCallback(() => setExpanded(true), [])
  const handleCollapse = useCallback(() => setExpanded(false), [])

  // Stream label for the fullscreen overlay header (the post's destination).
  const overlayStreamName = useStreamName(workspaceId, streamId)

  const handleSubmit = useCallback(
    async (editorContent?: JSONContent) => {
      if (!composer.canSend) return

      composer.setIsSending(true)
      setError(null)

      // Ends the compose session for EVERY submit, not just the flat send below:
      // a command dispatch or a hand-off to the panel finishes what the author
      // was writing here, so the next send must start from a fresh horizon
      // rather than inherit this one's `openedAt`.
      const composeTrace = await takeComposeTrace()

      const pendingAttachments = composer.getPendingAttachmentsSnapshot()
      const liveContent = editorContent ?? composer.content
      const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)

      // A bare `/steer`, a slashCommand node, or raw text matching an available
      // command dispatches instead of sending. Embedded steer (message content
      // around the directive) stays a normal message carrying `steer: true`;
      // the backend writes the message and follow-up command in one transaction.
      const sendPlan = planSend(normalizedContent)
      if (sendPlan?.kind === "command") {
        // Clear input immediately for responsiveness — same reset the server
        // path does. The dispatch consumes the command, so the user shouldn't
        // see their chip linger after pressing send.
        composer.setContent(EMPTY_DOC)
        composer.resolveDraft()
        setExpanded(false)
        try {
          await dispatchCommand(sendPlan)
        } catch {
          setError("Failed to queue command. Please try again.")
        } finally {
          composer.setIsSending(false)
        }
        return
      }
      const steerDirective = sendPlan?.kind === "steer-message" ? sendPlan : null

      // Armed for "Reply in conversation" but not confirmed live in THIS stream
      // (thread-live, or the board-post projection hasn't resolved yet): filing
      // flat here would re-interleave the channel. Hand off to the conversation
      // panel: the draft already lives at the conversation's own scope, which is
      // exactly the scope the panel's composer opens, so the text follows. The inline flat send below only runs once the
      // conversation is confirmed same-stream. A toast because the send didn't do
      // the obvious thing (post here): the panel can cover this view on mobile, so
      // the kept draft needs a word or the message reads as vanished (INV-63:
      // deferred action, no other on-screen signal).
      if (armedConversationId && conversationReplyLastActiveStreamId !== streamId) {
        redirectReplyToPanel(armedConversationId)
        toast.info("Opening the conversation to reply — your draft came with it.")
        composer.setIsSending(false)
        return
      }

      const messageContent = steerDirective?.content ?? normalizedContent
      const attachments = extractUploadedAttachments(messageContent)
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
          contentJson: messageContent,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
          ...(steerDirective && { steer: true as const }),
          composeTrace,
          // Armed by "Reply in conversation": file this send into the
          // conversation synchronously (Mechanism C). Cleared only on success —
          // a failed send keeps the filing armed alongside the restored content.
          conversation: armedConversationId ? { intent: "existing", conversationId: armedConversationId } : undefined,
        })

        disarm()
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
      planSend,
      dispatchCommand,
      armedConversationId,
      conversationReplyLastActiveStreamId,
      disarm,
      redirectReplyToPanel,
      takeComposeTrace,
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
      const attachments = extractUploadedAttachments(normalizedContent)
      const attachmentIds = attachments.map((a) => a.id)

      // A live send whose conversation has drifted into a thread hands off to the
      // panel (handleSubmit above). A scheduled send can't — there's no live thread
      // at fire time and the picker has no panel affordance — so it always files by
      // id. Surface that divergence when armed-and-drifted so the deferred reply
      // doesn't read as a flat channel send (INV-63: deferred action, no other
      // on-screen signal). Same-stream stays silent (the strip already shows it).
      const filesIntoDriftedConversation =
        armedConversationId !== null && conversationReplyLastActiveStreamId !== streamId

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
          conversation: armedConversationId ? { intent: "existing", conversationId: armedConversationId } : undefined,
        })
        disarm()
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
    [composer, scheduleMessageMutation, streamId, armedConversationId, conversationReplyLastActiveStreamId, disarm]
  )

  if (disabled && disabledReason) {
    // Use the same floating shell as the live composer so the banner anchors to
    // the bottom and publishes its height to `--composer-height`.
    // A plain in-flow div lands at the top of the absolutely-positioned stream
    // area and overlaps the first messages instead.
    return (
      <FloatingComposerShell ref={composerHeightRef} data-message-composer-root>
        <ComposerDisabledNotice reason={disabledReason} />
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
    // Explicit, not route-derived: the thread panel hosts this composer on
    // routes with no `:streamId` (the board), where the palette would fall to
    // workspace-only while dispatch held the thread's runtime commands.
    commandStreamId: streamId,
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
    onComposerFocus,
    onMobileChromeOpenChange: handleMobileChromeOpenChange,
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
        originById={stashOrigins}
        canStashCurrent={composer.canSend}
        onStashCurrent={stash.handleStashDraft}
        onRestore={stash.handleRestoreStashed}
        onDelete={stash.handleDeleteStashed}
        onOpenChange={stash.setPileOpen}
        controlsDisabled={composer.isSending}
      />
    ),
    stashedDraftsTriggerFab: (
      <StashedDraftsPicker
        drafts={stash.drafts}
        previewById={stashPreviews}
        originById={stashOrigins}
        canStashCurrent={composer.canSend}
        onStashCurrent={stash.handleStashDraft}
        onRestore={stash.handleRestoreStashed}
        onDelete={stash.handleDeleteStashed}
        onOpenChange={stash.setPileOpen}
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

  // Removing the filing changes metadata on the same draft. On mobile, retain
  // the strip's line box until the focused chrome session closes so neither the
  // composer nor keyboard moves during the action.
  let conversationReplyStrip = preserveConversationStripSpace ? <ConversationReplyStripPlaceholder /> : null
  if (armedConversationId) {
    conversationReplyStrip = (
      <ConversationReplyStrip
        title={conversationReplyTopic ?? "this conversation"}
        onCancel={dismissConversationFiling}
      />
    )
  }

  const StreamGlyph = stream ? STREAM_ICONS[stream.type] : null

  return (
    <>
      {/* Fullscreen editor — the shared overlay shell (Linear-style modal on
          desktop), the same surface the board authoring overlay uses. Posts into
          THIS stream: the header shows it, and the full composer prop bag (E2E,
          thread, schedule, quote, stash) rides along unchanged. */}
      <OverlayComposerShell
        open={expanded}
        onOpenChange={setExpanded}
        title="Message editor"
        header={
          <div className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-medium">
            {StreamGlyph && <StreamGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <span className="truncate">{overlayStreamName ?? "This stream"}</span>
          </div>
        }
      >
        {conversationReplyStrip}
        <div className="min-h-0 flex-1">
          <MessageComposer {...composerProps} expanded hideExpandedClose onCollapse={handleCollapse} autoFocus />
        </div>
      </OverlayComposerShell>

      {/* Inline composer — hidden while expanded. Mobile inline editing hides the
          composer via the body-level inline-edit presence attribute. */}
      <FloatingComposerShell ref={composerHeightRef} hidden={expanded} data-message-composer-root>
        <ComposerEncryptionNotice workspaceId={workspaceId} encrypted={e2eEnabled} streamId={e2eRootStreamId} />
        {!expanded && conversationReplyStrip}
        {!expanded && <MessageComposer {...composerProps} autoFocus={autoFocus} onExpandClick={handleExpandClick} />}
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      </FloatingComposerShell>
    </>
  )
}
