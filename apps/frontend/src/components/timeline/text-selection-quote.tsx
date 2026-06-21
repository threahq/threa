import { useEffect, useState, useCallback } from "react"
import { createPortal } from "react-dom"
import { Quote } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useInputMode } from "@/hooks/use-input-mode"
import { useQuoteReply } from "./quote-reply-context"

interface SelectionInfo {
  text: string
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
  streamId: string
}

/**
 * Shows a floating "Quote" button when the user selects text within a message.
 * Active mouse only — touch input uses select-none on messages.
 */
export function TextSelectionQuote({ streamId }: TextSelectionQuoteProps) {
  const inputMode = useInputMode()
  const quoteReplyCtx = useQuoteReply()
  const [selection, setSelection] = useState<SelectionInfo | null>(null)

  const handleSelectionChange = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      setSelection(null)
      return
    }

    const text = sel.toString().trim()
    if (!text) {
      setSelection(null)
      return
    }

    const range = sel.getRangeAt(0)

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

    setSelection({
      text,
      messageId: startCtx.messageId,
      streamId,
      authorName,
      authorId,
      actorType,
      rect,
    })
  }, [streamId])

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
    quoteReplyCtx.triggerQuoteReply({
      messageId: selection.messageId,
      streamId: selection.streamId,
      authorName: selection.authorName,
      authorId: selection.authorId,
      actorType: selection.actorType,
      snippet: selection.text,
    })
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }, [selection, quoteReplyCtx])

  if (inputMode !== "mouse" || !selection || !quoteReplyCtx) return null

  return createPortal(
    <div
      className="fixed z-50 -translate-x-1/2 animate-in fade-in-0 zoom-in-95"
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
    </div>,
    document.body
  )
}
