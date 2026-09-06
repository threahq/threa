import { createContext, useContext, useCallback, useMemo, useRef } from "react"
import type { ReactNode } from "react"
import type { ContentRange, JSONContent } from "@threahq/types"

export interface QuoteReplyData {
  messageId: string
  streamId: string
  authorName: string
  authorId: string
  actorType: string
  /** Markdown content to quote (preserves formatting) */
  snippet: string
  /** Source revision the quote pins to; null when the trigger can't know it. */
  version: number | null
  /** Span inside the pinned version; null quotes the whole message. */
  range: ContentRange | null
}

interface QuoteReplyContextValue {
  /** Trigger a quote reply — called by message actions */
  triggerQuoteReply: (data: QuoteReplyData) => void
  /** Register the composer's insertion handler */
  registerHandler: (handler: (data: QuoteReplyData) => void) => () => void
}

const QuoteReplyCtx = createContext<QuoteReplyContextValue | null>(null)

export function QuoteReplyProvider({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  const handlerRef = useRef<((data: QuoteReplyData) => void) | null>(null)

  const registerHandler = useCallback((handler: (data: QuoteReplyData) => void) => {
    handlerRef.current = handler
    return () => {
      handlerRef.current = null
    }
  }, [])

  const triggerQuoteReply = useCallback((data: QuoteReplyData) => {
    handlerRef.current?.(data)
  }, [])

  const value = useMemo(() => ({ triggerQuoteReply, registerHandler }), [triggerQuoteReply, registerHandler])

  // Disabled (e.g. archived conversations): render without the context so every
  // quote affordance — row menu, long-press, selection button — disappears
  // instead of routing into a composer that can't open.
  if (disabled) return <>{children}</>

  return <QuoteReplyCtx.Provider value={value}>{children}</QuoteReplyCtx.Provider>
}

export function useQuoteReply(): QuoteReplyContextValue | null {
  return useContext(QuoteReplyCtx)
}

/**
 * Append a `quoteReply` node to composer content, returning the new doc. Trailing
 * empty paragraphs are stripped so the quote appends cleanly, and exactly one
 * trailing paragraph is re-added for post-quote typing. Shared by every composer
 * that accepts a quote reply (the stream input and the board/conversation reply
 * composer) so the node shape and trimming stay in one place.
 */
export function appendQuoteReplyNode(content: JSONContent, data: QuoteReplyData): JSONContent {
  const quoteNode: JSONContent = {
    type: "quoteReply",
    attrs: {
      messageId: data.messageId,
      streamId: data.streamId,
      authorName: data.authorName,
      authorId: data.authorId,
      actorType: data.actorType,
      snippet: data.snippet,
      version: data.version,
      range: data.range,
    },
  }

  const trimmedBlocks = [...(content.content ?? [])]
  while (
    trimmedBlocks.length > 0 &&
    trimmedBlocks[trimmedBlocks.length - 1].type === "paragraph" &&
    (trimmedBlocks[trimmedBlocks.length - 1].content?.length ?? 0) === 0
  ) {
    trimmedBlocks.pop()
  }

  return { type: "doc", content: [...trimmedBlocks, quoteNode, { type: "paragraph" }] }
}
