import { afterEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
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
