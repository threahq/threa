import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD, type UnsharedReference } from "@threahq/types"
import { messagesApi } from "@/api/messages"
import { db } from "@/db"
import { unsharedReferenceKeys } from "@/hooks/use-unshared-references"
import { QuoteReplyBlock } from "./quote-reply-block"
import { BlockquoteBlock } from "./blockquote-block"
import { MarkdownBlockProvider, composeBlockCollapseKey, hashMarkdownBlock } from "./markdown-block-context"
import * as preferencesModule from "@/contexts/preferences-context"
import * as hooksModule from "@/hooks"
import * as userProfileModule from "@/components/user-profile"
import * as lineMeasureModule from "./use-measured-line-count"

let currentPrefs: { blockquoteCollapseThreshold?: number } | null = {
  blockquoteCollapseThreshold: DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD,
}

// JSDOM has no layout, so the rendered-height measurement is supplied here.
let measure: lineMeasureModule.MeasuredLines = { lineCount: 1, lineHeightPx: 20 }

function buildPreferencesContext() {
  if (!currentPrefs) return null
  return {
    preferences: currentPrefs,
    resolvedTheme: "light",
    isLoading: false,
    updatePreference: vi.fn(),
    updateAccessibility: vi.fn(),
    updateKeyboardShortcut: vi.fn(),
    resetKeyboardShortcut: vi.fn(),
    resetAllKeyboardShortcuts: vi.fn(),
  } as unknown as ReturnType<typeof preferencesModule.usePreferences>
}

function renderQuoteReply(ui: React.ReactElement, messageId = "msg_container", workspaceId = "ws_test") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/w/${workspaceId}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId"
            element={<MarkdownBlockProvider messageId={messageId}>{ui}</MarkdownBlockProvider>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return queryClient
}

/** Inline `max-height` clamp the collapsed body carries, if any. */
function clampStyle(): string | undefined {
  const el = document.querySelector<HTMLElement>('[style*="max-height"]')
  return el?.style.maxHeight || undefined
}

const toggleName = /expand \d+ lines|collapse quote reply/i

describe("QuoteReplyBlock collapse behavior", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockImplementation(() => buildPreferencesContext())
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorName: () => "Alex",
      getActorInitials: () => "AL",
      getActorAvatar: () => ({ fallback: "AL" }),
      getUser: () => undefined,
      getPersona: () => undefined,
      getBot: () => undefined,
    } as unknown as ReturnType<typeof hooksModule.useActors>)
    vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({
      openUserProfile: vi.fn(),
    } as unknown as ReturnType<typeof userProfileModule.useUserProfile>)
    vi.spyOn(lineMeasureModule, "useMeasuredLineCount").mockImplementation(() => ({ ...measure, remeasure: () => {} }))
    vi.spyOn(messagesApi, "listUnsharedReferences").mockResolvedValue({ references: [] })
    currentPrefs = { blockquoteCollapseThreshold: DEFAULT_BLOCKQUOTE_COLLAPSE_THRESHOLD }
    measure = { lineCount: 1, lineHeightPx: 20 }
    await db.markdownBlockCollapse.clear()
  })

  afterEach(async () => {
    await db.markdownBlockCollapse.clear()
  })

  it("renders short quote replies with no fold chrome", () => {
    measure = { lineCount: 1, lineHeightPx: 20 }
    renderQuoteReply(
      <QuoteReplyBlock
        authorName="Alex"
        authorId="user_alex"
        actorType="user"
        streamId="stream_src"
        messageId="msg_src"
      >
        <p>Short quoted line.</p>
      </QuoteReplyBlock>
    )

    expect(screen.getByText("Short quoted line.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: toggleName })).not.toBeInTheDocument()
    expect(clampStyle()).toBeUndefined()
  })

  it("collapses long quote replies by default and clamps to threshold + half a line", () => {
    currentPrefs = { blockquoteCollapseThreshold: 4 }
    measure = { lineCount: 12, lineHeightPx: 20 }
    renderQuoteReply(
      <QuoteReplyBlock
        authorName="Alex"
        authorId="user_alex"
        actorType="user"
        streamId="stream_src"
        messageId="msg_src"
      >
        <p>A quoted reply long enough to fold.</p>
      </QuoteReplyBlock>
    )

    const toggle = screen.getByRole("button", { name: /expand 12 lines/i })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(clampStyle()).toBe(`${(4 + 0.5) * 20}px`)
  })

  it("expanding drops the clamp and persists the choice under the source-message namespace", async () => {
    const user = userEvent.setup()
    currentPrefs = { blockquoteCollapseThreshold: 2 }
    measure = { lineCount: 9, lineHeightPx: 20 }
    const containerId = "msg_container_qr"
    renderQuoteReply(
      <QuoteReplyBlock
        authorName="Alex"
        authorId="user_alex"
        actorType="user"
        streamId="stream_src"
        messageId="msg_src"
      >
        <p>Quoted content that folds.</p>
      </QuoteReplyBlock>,
      containerId
    )

    await user.click(screen.getByRole("button", { name: /expand 9 lines/i }))

    await waitFor(() => {
      expect(clampStyle()).toBeUndefined()
      expect(screen.getByRole("button", { name: /collapse quote reply/i })).toHaveAttribute("aria-expanded", "true")
    })

    const key = composeBlockCollapseKey(
      containerId,
      "quote-reply",
      hashMarkdownBlock("Quoted content that folds.", "stream_src/msg_src")
    )
    const row = await db.markdownBlockCollapse.get(key)
    expect(row?.collapsed).toBe(false)
    expect(row?.kind).toBe("quote-reply")
  })

  it("renders the outermost quote reply as a card and nested replies as a compact rail", () => {
    renderQuoteReply(
      <QuoteReplyBlock
        authorName="Alex"
        authorId="user_alex"
        actorType="user"
        streamId="stream_src"
        messageId="msg_src"
      >
        <p>Outer reply text.</p>
        <QuoteReplyBlock
          authorName="Bea"
          authorId="user_bea"
          actorType="user"
          streamId="stream_inner"
          messageId="msg_inner"
        >
          <p>Inner reply text.</p>
        </QuoteReplyBlock>
      </QuoteReplyBlock>,
      "msg_nested_card"
    )

    // Both quoted bodies and authors survive the nesting.
    expect(screen.getByText("Outer reply text.")).toBeInTheDocument()
    expect(screen.getByText("Inner reply text.")).toBeInTheDocument()
    expect(screen.getByText("Bea")).toBeInTheDocument()

    // Only the outermost card carries the leading Quote glyph; the nested rail
    // drops it so the heavy card chrome doesn't repeat at every level.
    expect(document.querySelectorAll(".lucide-quote")).toHaveLength(1)

    // The single card fill belongs to the outer block; the nested rail has none.
    expect(document.querySelectorAll(".bg-muted\\/30")).toHaveLength(1)
  })

  it("only the outer quote-reply folds when a blockquote is nested inside it", () => {
    // Outer is long enough to be collapsible, so it owns the only fold toggle
    // and suppresses the nested blockquote's chrome.
    currentPrefs = { blockquoteCollapseThreshold: 6 }
    measure = { lineCount: 25, lineHeightPx: 20 }
    renderQuoteReply(
      <QuoteReplyBlock
        authorName="Alex"
        authorId="user_alex"
        actorType="user"
        streamId="stream_src"
        messageId="msg_src"
      >
        <BlockquoteBlock>
          <p>Inner quote line.</p>
        </BlockquoteBlock>
      </QuoteReplyBlock>,
      "msg_nested_qr"
    )

    // Quote-reply renders its own toggle (collapsed by default).
    expect(screen.getAllByRole("button", { name: /expand 25 lines/i })).toHaveLength(1)
    // The nested blockquote does NOT render a fold toggle of its own.
    expect(screen.queryByRole("button", { name: /block quote/i })).not.toBeInTheDocument()
    expect(screen.getByText("Inner quote line.")).toBeInTheDocument()
  })
})

describe("QuoteReplyBlock unshared-reference prompt", () => {
  const unsharedQuote: UnsharedReference = {
    messageId: "msg_container",
    streamId: "stream_dst",
    sourceMessageId: "msg_src",
    flavor: "quote",
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(preferencesModule, "usePreferencesOptional").mockImplementation(() => buildPreferencesContext())
    vi.spyOn(hooksModule, "useActors").mockReturnValue({
      getActorAvatar: () => ({ fallback: "AL" }),
    } as unknown as ReturnType<typeof hooksModule.useActors>)
    vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({
      openUserProfile: vi.fn(),
    } as unknown as ReturnType<typeof userProfileModule.useUserProfile>)
    vi.spyOn(lineMeasureModule, "useMeasuredLineCount").mockImplementation(() => ({
      lineCount: 1,
      lineHeightPx: 20,
      remeasure: () => {},
    }))
  })

  const quote = (
    <QuoteReplyBlock authorName="Alex" authorId="user_alex" actorType="user" streamId="stream_src" messageId="msg_src">
      <p>Quoted line.</p>
    </QuoteReplyBlock>
  )

  it("should share the carrying message's references and drop the prompt when Share it succeeds", async () => {
    const user = userEvent.setup()
    vi.spyOn(messagesApi, "listUnsharedReferences")
      .mockResolvedValueOnce({ references: [unsharedQuote] })
      .mockResolvedValue({ references: [] })
    const share = vi.spyOn(messagesApi, "shareReferences").mockResolvedValue(undefined)
    renderQuoteReply(quote)

    expect(await screen.findByRole("status")).toHaveTextContent("Readers can't open the quoted message")
    await user.click(screen.getByRole("button", { name: "Share it" }))

    await waitFor(() => expect(screen.queryByTestId("unshared-reference-prompt")).not.toBeInTheDocument())
    expect(share).toHaveBeenCalledWith("ws_test", "msg_container")
  })

  it("should keep the prompt and say why when Share it fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(messagesApi, "listUnsharedReferences").mockResolvedValue({ references: [unsharedQuote] })
    vi.spyOn(messagesApi, "shareReferences").mockRejectedValue(new Error("You can no longer read the source"))
    const toastError = vi.spyOn(toast, "error").mockReturnValue("" as ReturnType<typeof toast.error>)
    renderQuoteReply(quote)

    await user.click(await screen.findByRole("button", { name: "Share it" }))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't share"))
    expect(screen.getByTestId("unshared-reference-prompt")).toBeInTheDocument()
  })

  it("should not prompt for another message's unshared quote of the same source", async () => {
    vi.spyOn(messagesApi, "listUnsharedReferences").mockResolvedValue({
      references: [{ ...unsharedQuote, messageId: "msg_other" }],
    })
    const queryClient = renderQuoteReply(quote)

    await waitFor(() =>
      expect(queryClient.getQueryState(unsharedReferenceKeys.list("ws_test"))?.status).toBe("success")
    )
    expect(screen.queryByTestId("unshared-reference-prompt")).not.toBeInTheDocument()
  })
})
