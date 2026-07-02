import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, useRef } from "react"
import { QuoteReplyProvider, useQuoteReply, type QuoteReplyData } from "./quote-reply-context"
import { TextSelectionQuote } from "./text-selection-quote"

const BODY_TEXT = "Hello there, this is the body."

/** A message row shaped like `MessageItem` — the data attributes and
 * `.message-content .markdown-content` structure `TextSelectionQuote` reads. */
function MessageRow({ messageId, streamId }: { messageId: string; streamId: string }) {
  return (
    <div
      data-message-id={messageId}
      data-stream-id={streamId}
      data-author-name="Alice"
      data-author-id="usr_alice"
      data-actor-type="user"
    >
      <div className="message-content">
        <div className="markdown-content">{BODY_TEXT}</div>
      </div>
    </div>
  )
}

/** Registers the provider handler so a triggered quote is observable. */
function CaptureQuote({ onQuote }: { onQuote: (d: QuoteReplyData) => void }) {
  const ctx = useQuoteReply()
  useEffect(() => ctx?.registerHandler(onQuote), [ctx, onQuote])
  return null
}

/** Point `window.getSelection` at a non-collapsed range over `node`. */
function mockSelection(node: Node, text: string) {
  const range = {
    startContainer: node,
    endContainer: node,
    getBoundingClientRect: () => ({ top: 120, left: 40, width: 90, height: 20 }) as DOMRect,
  }
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: () => {},
  } as unknown as Selection)
}

function fireSelectionChange() {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"))
  })
}

afterEach(() => vi.restoreAllMocks())

describe("TextSelectionQuote", () => {
  it("quotes the selected snippet against the row's own stream, routed to the scoped composer", async () => {
    const user = userEvent.setup()
    const onQuote = vi.fn()

    function Scene() {
      const ref = useRef<HTMLDivElement>(null)
      return (
        <QuoteReplyProvider>
          <CaptureQuote onQuote={onQuote} />
          {/* Anchor prop differs from the row's data-stream-id: the row wins. */}
          <TextSelectionQuote streamId="stream_anchor" containerRef={ref} />
          <div ref={ref}>
            <MessageRow messageId="msg_1" streamId="stream_thread" />
          </div>
        </QuoteReplyProvider>
      )
    }
    render(<Scene />)

    const bodyEl = screen.getByText(BODY_TEXT)
    mockSelection(bodyEl.firstChild as Node, "Hello there")
    fireSelectionChange()

    await user.click(await screen.findByRole("button", { name: /quote/i }))

    expect(onQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg_1",
        streamId: "stream_thread",
        snippet: "Hello there",
        authorName: "Alice",
        authorId: "usr_alice",
        actorType: "user",
      })
    )
  })

  it("ignores a selection outside its own container (sibling cards keep their own instance)", () => {
    function Scene() {
      const ref = useRef<HTMLDivElement>(null)
      return (
        <QuoteReplyProvider>
          {/* The instance is scoped to the empty ref div; the row lives outside it. */}
          <TextSelectionQuote streamId="stream_anchor" containerRef={ref} />
          <div ref={ref} />
          <div>
            <MessageRow messageId="msg_out" streamId="stream_other" />
          </div>
        </QuoteReplyProvider>
      )
    }
    render(<Scene />)

    const bodyEl = screen.getByText(BODY_TEXT)
    mockSelection(bodyEl.firstChild as Node, "Hello there")
    fireSelectionChange()

    expect(screen.queryByRole("button", { name: /quote/i })).toBeNull()
  })
})
