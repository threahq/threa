import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useEffect, useRef } from "react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { JSONContent } from "@threa/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as shareHandoffStoreModule from "@/stores/composer-handoff-store"
import * as useMobileModule from "@/hooks/use-mobile"
import { registerReferenceSource, resetReferenceSourceStoreCache } from "@/stores/reference-source-store"
import { QuoteReplyProvider, useQuoteReply, type QuoteReplyData } from "./quote-reply-context"
import { TextSelectionQuote } from "./text-selection-quote"

const BODY_TEXT = "Hello there, this is the body."
/** The same body the row renders, with "this" bold — a slice across the mark
 * proves the snippet is the formatted span, not the DOM's plain string. */
const BODY_JSON: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello there, " },
        { type: "text", text: "this", marks: [{ type: "bold" }] },
        { type: "text", text: " is the body." },
      ],
    },
  ],
}
const BODY_MARKDOWN = "Hello there, **this** is the body."

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

/**
 * Point `window.getSelection` at a real DOM range over `node`, spanning the
 * characters `[start, end)`. Real ranges matter: the component derives the
 * range resolver's prefix text from the DOM between the body's start and the
 * selection's start.
 */
function mockSelection(node: Node, start: number, end: number) {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  range.getBoundingClientRect = () => ({ top: 120, left: 40, width: 90, height: 20 }) as DOMRect
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => range.toString(),
    getRangeAt: () => range,
    removeAllRanges: () => {},
  } as unknown as Selection)
}

function fireSelectionChange() {
  act(() => {
    document.dispatchEvent(new Event("selectionchange"))
  })
}

function Scene({ onQuote }: { onQuote: (d: QuoteReplyData) => void }) {
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

afterEach(() => {
  vi.restoreAllMocks()
  resetReferenceSourceStoreCache()
})

describe("TextSelectionQuote", () => {
  it("pins the quote to the rendered revision and the selected span, quoting the formatted slice", async () => {
    const user = userEvent.setup()
    const onQuote = vi.fn()
    registerReferenceSource("msg_1", { contentJson: BODY_JSON, revision: 4, contentMarkdown: BODY_MARKDOWN })

    render(<Scene onQuote={onQuote} />)

    const bodyEl = screen.getByText(BODY_TEXT)
    // "this is" — starts inside the bold mark and runs past it.
    mockSelection(bodyEl.firstChild as Node, 13, 20)
    fireSelectionChange()

    await user.click(await screen.findByRole("button", { name: /quote/i }))

    expect(onQuote).toHaveBeenCalledWith({
      messageId: "msg_1",
      streamId: "stream_thread",
      authorName: "Alice",
      authorId: "usr_alice",
      actorType: "user",
      snippet: "**this** is",
      version: 4,
      range: { from: 14, to: 21 },
    })
  })

  it("falls back to a full quote of the pinned revision when the selection can't be mapped", async () => {
    const user = userEvent.setup()
    const onQuote = vi.fn()
    registerReferenceSource("msg_1", { contentJson: BODY_JSON, revision: 4, contentMarkdown: BODY_MARKDOWN })

    render(<Scene onQuote={onQuote} />)

    const bodyEl = screen.getByText(BODY_TEXT)
    const range = document.createRange()
    range.selectNodeContents(bodyEl.firstChild as Node)
    range.getBoundingClientRect = () => ({ top: 120, left: 40, width: 90, height: 20 }) as DOMRect
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      // Text the body does not contain — the resolver returns no range.
      toString: () => "wholly unrelated wording",
      getRangeAt: () => range,
      removeAllRanges: () => {},
    } as unknown as Selection)
    fireSelectionChange()

    await user.click(await screen.findByRole("button", { name: /quote/i }))

    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ snippet: BODY_MARKDOWN, version: 4, range: null }))
  })

  it("sends the lenient unpinned form when the row's content isn't registered", async () => {
    const user = userEvent.setup()
    const onQuote = vi.fn()

    render(<Scene onQuote={onQuote} />)

    const bodyEl = screen.getByText(BODY_TEXT)
    mockSelection(bodyEl.firstChild as Node, 0, 11)
    fireSelectionChange()

    await user.click(await screen.findByRole("button", { name: /quote/i }))

    expect(onQuote).toHaveBeenCalledWith(
      expect.objectContaining({ snippet: "Hello there", version: null, range: null })
    )
  })

  it("ignores a selection outside its own container (sibling cards keep their own instance)", () => {
    function OutsideScene() {
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
    render(<OutsideScene />)

    const bodyEl = screen.getByText(BODY_TEXT)
    mockSelection(bodyEl.firstChild as Node, 0, 11)
    fireSelectionChange()

    expect(screen.queryByRole("button", { name: /quote/i })).toBeNull()
  })
})

/** The same scene under a workspace route, so the share picker can mount. */
function ShareScene() {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_thread"]}>
      <Routes>
        <Route
          path="/w/:workspaceId/s/:streamId"
          element={
            <QuoteReplyProvider>
              <TextSelectionQuote streamId="stream_anchor" containerRef={ref} />
              <div ref={ref}>
                <MessageRow messageId="msg_1" streamId="stream_thread" />
              </div>
            </QuoteReplyProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

function stubPickerWithOneChannel() {
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(
    undefined as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUnreadState>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([
    {
      id: "ch_target",
      type: "channel",
      visibility: "public",
      displayName: "#general",
      slug: "general",
      archivedAt: null,
      rootStreamId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
    [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>
  )
  return vi.spyOn(shareHandoffStoreModule, "queueShareHandoff").mockImplementation(() => {})
}

describe("TextSelectionQuote — sharing a selection", () => {
  it("hands the picker the highlighted span, pinned to the rendered revision", async () => {
    const user = userEvent.setup()
    const queue = stubPickerWithOneChannel()
    registerReferenceSource("msg_1", { contentJson: BODY_JSON, revision: 4, contentMarkdown: BODY_MARKDOWN })

    render(<ShareScene />)

    const bodyEl = screen.getByText(BODY_TEXT)
    mockSelection(bodyEl.firstChild as Node, 13, 20)
    fireSelectionChange()

    await user.click(await screen.findByRole("button", { name: /share/i }))

    // The picker previews the formatted slice, not the DOM's flat string.
    const dialog = await screen.findByRole("dialog", { name: /share message/i })
    expect(dialog.querySelector("strong")?.textContent).toBe("this")
    expect(dialog.textContent).not.toContain("Hello there")

    fireEvent.click(document.querySelector<HTMLElement>('[cmdk-item][data-value="ch_target"]')!)

    expect(queue).toHaveBeenCalledWith("ch_target", {
      messageId: "msg_1",
      streamId: "stream_thread",
      authorName: "Alice",
      authorId: "usr_alice",
      actorType: "user",
      version: 4,
      range: { from: 14, to: 21 },
    })
  })

  it("shares the whole pinned message when the selection can't be mapped, and previews that", async () => {
    const user = userEvent.setup()
    const queue = stubPickerWithOneChannel()
    registerReferenceSource("msg_1", { contentJson: BODY_JSON, revision: 4, contentMarkdown: BODY_MARKDOWN })

    render(<ShareScene />)

    const bodyEl = screen.getByText(BODY_TEXT)
    const range = document.createRange()
    range.selectNodeContents(bodyEl.firstChild as Node)
    range.getBoundingClientRect = () => ({ top: 120, left: 40, width: 90, height: 20 }) as DOMRect
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "wholly unrelated wording",
      getRangeAt: () => range,
      removeAllRanges: () => {},
    } as unknown as Selection)
    fireSelectionChange()

    await user.click(await screen.findByRole("button", { name: /share/i }))

    const dialog = await screen.findByRole("dialog", { name: /share message/i })
    expect(dialog.textContent).toContain("Hello there")

    fireEvent.click(document.querySelector<HTMLElement>('[cmdk-item][data-value="ch_target"]')!)

    expect(queue).toHaveBeenCalledWith("ch_target", {
      messageId: "msg_1",
      streamId: "stream_thread",
      authorName: "Alice",
      authorId: "usr_alice",
      actorType: "user",
      version: 4,
      range: null,
    })
  })
})
