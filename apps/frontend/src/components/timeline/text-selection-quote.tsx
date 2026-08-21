import { useEffect, useState, useCallback, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useParams } from "react-router-dom"
import { Quote, Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ShareMessageModal } from "@/components/share/share-message-modal"
import type { SharedMessageAttrs } from "@/components/editor/shared-message-extension"
import { useInputMode } from "@/hooks/use-input-mode"
import { resolveQuoteSelection, resolveShareSelection } from "@/lib/quote-selection"
import { getReferenceSource } from "@/stores/reference-source-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { useQuoteReply } from "./quote-reply-context"

interface SelectionInfo {
  text: string
  prefixText: string
  messageId: string
  streamId: string
  authorName: string
  authorId: string
  actorType: string
  rect: DOMRect
}

/**
 * Finds the closest message element from a DOM node and extracts its metadata.
 */
function getMessageContext(node: Node): { messageId: string; element: HTMLElement } | null {
  const el = node instanceof HTMLElement ? node : node.parentElement
  if (!el) return null
  const messageEl = el.closest<HTMLElement>("[data-message-id]")
  if (!messageEl) return null
  const messageId = messageEl.getAttribute("data-message-id")
  if (!messageId) return null
  return { messageId, element: messageEl }
}

/**
 * The rendered text between the body's start and the selection's start. Feeds
 * the range resolver's tie-break when the selected words repeat in the message.
 */
function textBeforeSelection(contentEl: Element, range: Range): string {
  const prefix = contentEl.ownerDocument.createRange()
  prefix.selectNodeContents(contentEl)
  prefix.setEnd(range.startContainer, range.startOffset)
  return prefix.toString()
}

/**
 * Extract author metadata from a message DOM element via data attributes.
 */
function getAuthorFromDom(messageEl: HTMLElement): { authorName: string; authorId: string; actorType: string } {
  // Walk up to find the element with data-author-name (set on MessageLayout root)
  const authorEl =
    messageEl.closest<HTMLElement>("[data-author-name]") ?? messageEl.querySelector<HTMLElement>("[data-author-name]")
  return {
    authorName: authorEl?.getAttribute("data-author-name")?.trim() ?? "Unknown",
    authorId: authorEl?.getAttribute("data-author-id")?.trim() ?? "",
    actorType: authorEl?.getAttribute("data-actor-type")?.trim() ?? "user",
  }
}

interface TextSelectionQuoteProps {
  /** Anchor stream for the quote when a row omits its own `data-stream-id`. The
   * stream timeline is single-stream, so this is its whole answer; a board
   * conversation spans streams, so the row's DOM `data-stream-id` wins. */
  streamId: string
  /** Scope detection to selections inside this element. Omit for the stream
   * timeline (one instance, whole document). The board mounts one instance per
   * card — each must ignore selections in sibling cards so the quote routes to
   * its own composer, not the last-mounted provider's. */
  containerRef?: RefObject<HTMLElement | null>
}

/**
 * Floating Quote / Share controls for a text selection inside a message. Both
 * pin the reference to the revision on screen and the span the reader
 * highlighted. Active mouse only — touch input uses select-none on messages and
 * reaches the same two actions through the action drawer.
 */
export function TextSelectionQuote({ streamId, containerRef }: TextSelectionQuoteProps) {
  const inputMode = useInputMode()
  const quoteReplyCtx = useQuoteReply()
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  // Survives the selection being cleared: the picker stays open after the
  // highlight is gone, and the preview is what the share will actually render.
  const [shareRequest, setShareRequest] = useState<{
    attrs: SharedMessageAttrs
    previewMarkdown: string | null
  } | null>(null)
  // Sharing a sealed message decrypts it whole, which is the row menu's
  // confirmed path — a span of one has nothing to pin, so the toolbar offers
  // Quote only there.
  const selectionStream = useStreamFromStore(selection?.streamId ?? streamId)
  const canShare = workspaceId !== undefined && selectionStream?.e2eEnabled !== true

  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelection(null)
      return
    }

    const range = sel.getRangeAt(0)

    // Scope to this instance's container when one is given (a board card/panel,
    // or the timeline beside a side panel): a selection outside it belongs to
    // another instance. Gate on the raw range node first — before the string
    // serialization and DOM walks below — so the N instances a board mounts each
    // bail cheaply on every `selectionchange` tick during a drag.
    if (containerRef && !containerRef.current?.contains(range.startContainer)) {
      setSelection(null)
      return
    }

    const text = sel.toString().trim()
    if (!text) {
      setSelection(null)
      return
    }

    // Both ends of the selection must be within the same message
    const startCtx = getMessageContext(range.startContainer)
    const endCtx = getMessageContext(range.endContainer)
    if (!startCtx || !endCtx || startCtx.messageId !== endCtx.messageId) {
      setSelection(null)
      return
    }

    // Must be within the message content area (not author name, timestamp, etc.)
    const contentEl = startCtx.element.querySelector(".message-content .markdown-content")
    if (!contentEl || !contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) {
      setSelection(null)
      return
    }

    const rect = range.getBoundingClientRect()
    const { authorName, authorId, actorType } = getAuthorFromDom(startCtx.element)
    // A conversation row carries its own stream (one root, many threads), so the
    // quote points at where the message actually lives; fall back to the anchor.
    const messageStreamId = startCtx.element.getAttribute("data-stream-id")?.trim() || streamId

    setSelection({
      text,
      prefixText: textBeforeSelection(contentEl, range),
      messageId: startCtx.messageId,
      streamId: messageStreamId,
      authorName,
      authorId,
      actorType,
      rect,
    })
  }, [streamId, containerRef])

  useEffect(() => {
    // Clear any stale selection when leaving mouse input, so switching back to a
    // mouse doesn't re-show the quote affordance from a selection that's gone.
    if (inputMode !== "mouse") {
      setSelection(null)
      return
    }

    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [inputMode, handleSelectionChange])

  const handleQuote = useCallback(() => {
    if (!selection || !quoteReplyCtx) return
    const pin = resolveQuoteSelection(getReferenceSource(selection.messageId), {
      text: selection.text,
      prefixText: selection.prefixText,
    })
    quoteReplyCtx.triggerQuoteReply({
      messageId: selection.messageId,
      streamId: selection.streamId,
      authorName: selection.authorName,
      authorId: selection.authorId,
      actorType: selection.actorType,
      ...pin,
    })
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [selection, quoteReplyCtx])

  const handleShare = useCallback(() => {
    if (!selection) return
    const pin = resolveShareSelection(getReferenceSource(selection.messageId), {
      text: selection.text,
      prefixText: selection.prefixText,
    })
    setShareRequest({
      attrs: {
        messageId: selection.messageId,
        streamId: selection.streamId,
        authorName: selection.authorName,
        authorId: selection.authorId,
        actorType: selection.actorType,
        version: pin.version,
        range: pin.range,
      },
      previewMarkdown: pin.previewMarkdown,
    })
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [selection])

  const toolbar =
    inputMode === "mouse" && selection && quoteReplyCtx
      ? createPortal(
          <div
            className="fixed z-50 flex -translate-x-1/2 items-center gap-1 animate-in fade-in-0 zoom-in-95"
            style={{ top: selection.rect.top - 36, left: selection.rect.left + selection.rect.width / 2 }}
          >
            <Button
              variant="secondary"
              size="sm"
              className="h-7 gap-1.5 rounded-full shadow-md px-3 text-xs"
              onClick={handleQuote}
            >
              <Quote className="h-3 w-3" />
              Quote
            </Button>
            {canShare && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 gap-1.5 rounded-full shadow-md px-3 text-xs"
                onClick={handleShare}
              >
                <Share2 className="h-3 w-3" />
                Share
              </Button>
            )}
          </div>,
          document.body
        )
      : null

  return (
    <>
      {toolbar}
      {shareRequest && workspaceId && (
        <ShareMessageModal
          open
          onOpenChange={(next) => {
            if (!next) setShareRequest(null)
          }}
          workspaceId={workspaceId}
          attrs={shareRequest.attrs}
          previewMarkdown={shareRequest.previewMarkdown}
        />
      )}
    </>
  )
}
