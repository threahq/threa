import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { SyncEngineContext } from "@/sync/sync-engine"
import { MessageActionDrawer } from "./message-action-drawer"
import type { MessageActionContext } from "./message-actions"

const BODY = "Hello there, this is the body."

function mountDrawer(context: Partial<MessageActionContext>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      {/* Reactions read the engine on mount; this drawer test never reacts. */}
      <SyncEngineContext.Provider value={{} as never}>
        <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
          <MessageActionDrawer
            open
            onOpenChange={() => {}}
            authorName="Alice"
            context={{
              contentMarkdown: BODY,
              messageId: "msg_1",
              workspaceId: "ws_1",
              streamId: "stream_1",
              actorType: "user",
              replyUrl: "/w/ws_1/s/stream_1?m=msg_1",
              ...context,
            }}
          />
        </MemoryRouter>
      </SyncEngineContext.Provider>
    </QueryClientProvider>
  )
}

/** Select `[start, end)` of the drawer's rendered body, as a long-press does. */
function selectInBody(start: number, end: number) {
  const node = screen.getByText(BODY).firstChild as Node
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => range.toString(),
    getRangeAt: () => range,
    removeAllRanges: () => {},
    addRange: () => {},
  } as unknown as Selection)
  act(() => {
    document.dispatchEvent(new Event("selectionchange"))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("MessageActionDrawer — sharing a selection", () => {
  it("hands the highlighted span to the share trigger", async () => {
    const onShareWithSelection = vi.fn()
    mountDrawer({ onQuoteReplyWithSelection: vi.fn(), onShareWithSelection })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)

    // fireEvent, not userEvent: a real pointer sequence reaches vaul's drag
    // handling, which reads a computed transform jsdom does not produce.
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }))

    expect(onShareWithSelection).toHaveBeenCalledWith({ text: "this is", prefixText: "Hello there, " })
  })

  it("offers Quote alone when the row can't share a span", async () => {
    mountDrawer({ onQuoteReplyWithSelection: vi.fn() })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)

    expect(await screen.findByRole("button", { name: /^quote$/i })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^share$/i })).not.toBeInTheDocument()
  })
})

describe("MessageActionDrawer — offering the selection pill", () => {
  it("waits for the selection to stop moving before offering the pill", async () => {
    mountDrawer({ onQuoteReplyWithSelection: vi.fn(), onShareWithSelection: vi.fn() })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)

    // Mid-drag: the range exists but hasn't settled, so nothing is offered yet.
    expect(screen.queryByTestId("selection-pill")).not.toBeInTheDocument()
    expect(await screen.findByTestId("selection-pill")).toBeInTheDocument()
  })

  it("stands down while a finger is still on the message", async () => {
    mountDrawer({ onQuoteReplyWithSelection: vi.fn(), onShareWithSelection: vi.fn() })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)
    await screen.findByTestId("selection-pill")

    // On the message itself: a bare `document` event reads as a press outside
    // the sheet, which is Radix's dismiss gesture rather than a selection drag.
    fireEvent.pointerDown(screen.getByText(BODY))
    expect(screen.queryByTestId("selection-pill")).not.toBeInTheDocument()

    // pointercancel, not pointerup: vaul's release handler reads a computed
    // transform jsdom never produces, and it only listens for the latter.
    fireEvent.pointerCancel(screen.getByText(BODY))
    await waitFor(() => expect(screen.getByTestId("selection-pill")).toBeInTheDocument())
  })

  it("puts the count in the header and leaves the bottom of the sheet to the message", async () => {
    mountDrawer({ onQuoteReplyWithSelection: vi.fn(), onShareWithSelection: vi.fn() })

    fireEvent.click(screen.getByText(BODY))
    expect(screen.getByTestId("expanded-quote-title")).toHaveTextContent("Full message")

    selectInBody(13, 20)
    await waitFor(() => expect(screen.getByTestId("expanded-quote-title")).toHaveTextContent("7 characters selected"))
    expect(screen.queryByText(/long-press the message/i)).not.toBeInTheDocument()
  })

  it("listens again when the finger lifts somewhere other than the pill", async () => {
    mountDrawer({ onQuoteReplyWithSelection: vi.fn(), onShareWithSelection: vi.fn() })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)
    const pill = await screen.findByTestId("selection-pill")

    // Press the pill, slide off it, lift elsewhere: the release never reaches
    // the pill, so the guard has to come off the document instead. Left stuck,
    // every later selection is ignored and the actions send the old span.
    fireEvent.pointerDown(pill)
    fireEvent.pointerCancel(screen.getByText(BODY))

    selectInBody(0, 5)
    await waitFor(() => expect(screen.getByTestId("expanded-quote-title")).toHaveTextContent("5 characters selected"))
  })

  it("opts the pill out of the sheet's own drag gesture", async () => {
    mountDrawer({ onQuoteReplyWithSelection: vi.fn(), onShareWithSelection: vi.fn() })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)

    // vaul reads a press on the sheet as a drag unless there is highlighted
    // text, and pressing the pill is what collapses the highlight. Without the
    // opt-out a downward drag on the pill drags the sheet shut.
    expect(await screen.findByTestId("selection-pill")).toHaveAttribute("data-vaul-no-drag")
  })

  it("keeps the selection it read when the pill itself is pressed", async () => {
    const onQuoteReplyWithSelection = vi.fn()
    mountDrawer({ onQuoteReplyWithSelection })

    fireEvent.click(screen.getByText(BODY))
    selectInBody(13, 20)
    const pill = await screen.findByTestId("selection-pill")

    // Chrome collapses the selection when a fixed overlay is touched. The click
    // that follows must still carry the span the reader highlighted.
    fireEvent.pointerDown(pill)
    act(() => {
      vi.spyOn(window, "getSelection").mockReturnValue({
        isCollapsed: true,
        rangeCount: 0,
        removeAllRanges: () => {},
        addRange: () => {},
      } as unknown as Selection)
      document.dispatchEvent(new Event("selectionchange"))
    })
    fireEvent.click(screen.getByRole("button", { name: /^quote$/i }))

    expect(onQuoteReplyWithSelection).toHaveBeenCalledWith({ text: "this is", prefixText: "Hello there, " })
  })
})
