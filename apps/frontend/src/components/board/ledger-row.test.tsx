import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MediaGalleryProvider, PanelProvider, ServicesProvider, TraceProvider } from "@/contexts"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { RenderableMessage } from "@/components/message/message-item"
import * as contextsModule from "@/contexts"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as messageReactionsModule from "@/hooks/use-message-reactions"
import * as userProfileModule from "@/components/user-profile"
import * as syncEngineModule from "@/sync/sync-engine"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as touchCapableModule from "@/hooks/use-touch-capable"
import * as useMobileModule from "@/hooks/use-mobile"
import * as messageHistoryDialogModule from "@/components/timeline/message-history-dialog"
import * as conversationsModule from "@/hooks/use-conversations"
import { spyOnExport } from "@/test/spy"
import { LedgerEventGroup, LedgerRow } from "./ledger-row"

const WS = "ws_1"
const STREAM = "stream_1"
const CONV = "conv_1"

function message(overrides: Partial<RenderableMessage> = {}): RenderableMessage {
  return {
    id: "msg_1",
    authorId: "usr_other",
    authorType: "user",
    contentMarkdown: "Ledger rows compress a message to one line",
    reactions: {},
    createdAt: "2026-07-28T10:04:00.000Z",
    ...overrides,
  }
}

function renderRow(overrides: Partial<Parameters<typeof LedgerRow>[0]> = {}) {
  const onToggle = overrides.onToggle ?? vi.fn()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ServicesProvider services={{ conversations: {} as never }}>
          <MemoryRouter initialEntries={[`/w/${WS}/board`]}>
            <MediaGalleryProvider>
              <TraceProvider>
                <PanelProvider>
                  <LedgerRow
                    workspaceId={WS}
                    streamId={STREAM}
                    message={message()}
                    authorName="Pierre"
                    currentUserId="usr_me"
                    expanded={false}
                    leadLineLength={80}
                    conversationId={CONV}
                    conversationRootStreamId={STREAM}
                    {...overrides}
                    onToggle={onToggle}
                  />
                </PanelProvider>
              </TraceProvider>
            </MediaGalleryProvider>
          </MemoryRouter>
        </ServicesProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { ...result, onToggle }
}

beforeEach(() => {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockReturnValue([] as never)
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockReturnValue(undefined as never)
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("usr_me")
  vi.spyOn(userProfileModule, "useUserProfile").mockReturnValue({ openUserProfile: vi.fn() })
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    setBoardStreamIds: vi.fn(),
  } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
  vi.spyOn(messageReactionsModule, "useMessageReactions").mockReturnValue({
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    toggleReaction: vi.fn(),
    toggleByEmoji: vi.fn(),
  } as unknown as ReturnType<typeof messageReactionsModule.useMessageReactions>)
  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { timezone: "UTC", locale: "en-US", timeFormat: "24h" },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
})

afterEach(() => vi.restoreAllMocks())

describe("LedgerRow collapsed", () => {
  it("shows the lead line, the time and the artifact chips", () => {
    renderRow({
      message: message({
        attachments: [{ id: "att_1", filename: "spec.pdf" } as never],
        linkPreviews: [
          { url: "https://example.com/postgres", contentType: "website", title: "Postgres upsert docs" } as never,
        ],
      }),
    })
    expect(screen.getByText("Ledger rows compress a message to one line")).toBeInTheDocument()
    expect(screen.getByText(/^\d{2}:\d{2}$/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open 1 attachment" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Postgres upsert docs" })).toHaveAttribute(
      "href",
      "https://example.com/postgres"
    )
  })

  it("renders emoji shortcodes in the lead line as emoji", () => {
    vi.spyOn(emojiModule, "useWorkspaceEmoji").mockReturnValue({
      toEmoji: (shortcode: string) => (shortcode === "tada" ? "🎉" : null),
    } as unknown as ReturnType<typeof emojiModule.useWorkspaceEmoji>)
    renderRow({ message: message({ contentMarkdown: ":tada: shipped" }) })
    expect(screen.getByText("🎉 shipped")).toBeInTheDocument()
  })

  it("renders a tombstone with no chips and no expand affordance", () => {
    renderRow({
      message: message({ contentMarkdown: "", deletedAt: "2026-07-28T11:00:00.000Z", attachments: [] }),
    })
    expect(screen.getByText("This message was deleted")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("falls back to the attachment count, then to a no-text marker, when the lead is empty", () => {
    const { unmount } = renderRow({
      message: message({ contentMarkdown: "", attachments: [{ id: "att_1" } as never, { id: "att_2" } as never] }),
    })
    expect(screen.getByText("📎 2")).toBeInTheDocument()
    unmount()
    renderRow({ message: message({ contentMarkdown: "---" }) })
    expect(screen.getByText("(no text)")).toBeInTheDocument()
  })

  it("keeps the link chip outside the expand button (no nested interactive element)", () => {
    renderRow({
      message: message({
        linkPreviews: [{ url: "https://example.com/x", contentType: "website", title: "Docs" } as never],
      }),
    })
    const rowButton = screen.getByRole("button", { name: /Pierre/ })
    expect(rowButton.querySelector("a")).toBeNull()
    expect(rowButton.querySelector("button")).toBeNull()
  })
})

describe("LedgerRow toggle", () => {
  it("fires onToggle on click and on Enter", async () => {
    const user = userEvent.setup()
    const { onToggle } = renderRow()
    const rowButton = screen.getByRole("button", { name: /Pierre:/ })
    await user.click(rowButton)
    rowButton.focus()
    await user.keyboard("{Enter}")
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it("renders the full message body when expanded, and minimizes from the header strip", async () => {
    const user = userEvent.setup()
    const { onToggle } = renderRow({ expanded: true })
    expect(screen.getByText("Ledger rows compress a message to one line")).toBeInTheDocument()
    expect(screen.getByText("Pierre")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Collapse message" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("colorizes the rail beside an expanded agent body instead of a flush inner stripe", () => {
    // A colored actor overlays its 2px border ON the ledger rail (the branch-rows
    // idiom: -ml-2.5 pulls it over the wrapper's border, pl-2 pads the avatar off
    // it) and the row's own inner accent — the flush-against-the-avatar bug — is
    // suppressed.
    const { container } = renderRow({ expanded: true, message: message({ authorType: "persona" }) })
    const overlay = container.querySelector(".border-primary.border-l-2")
    expect(overlay).toBeTruthy()
    expect(overlay!.className).toContain("pl-2")
    // The inset that pulls the colored border over the wrapper's neutral rail
    // sits on the row's break-out wrapper, an ancestor of the surface element.
    expect(overlay!.closest("[class*='-ml-2.5']")).toBeTruthy()
    expect(container.querySelector("[class*='shadow-[inset_3px']")).toBeNull()
  })

  it("keeps a user-authored expanded body plain against the neutral rail", () => {
    const { container } = renderRow({ expanded: true })
    expect(container.querySelector(".border-primary")).toBeNull()
    expect(container.querySelector(".-ml-2\\.5")).toBeNull()
  })
})

describe("LedgerRow actions", () => {
  it("opens the shared message menu on right-click", async () => {
    const user = userEvent.setup()
    renderRow({ onNewSubtopic: vi.fn(), onMoveToSubtopic: vi.fn() })
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Pierre:/ }) })
    expect(await screen.findByRole("menuitem", { name: /New sub-topic/i })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Move to sub-topic/i })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Label message/i })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Save for later/i })).toBeInTheDocument()
  })
})

describe("LedgerRow touch long-press", () => {
  beforeEach(() => {
    vi.spyOn(touchCapableModule, "useTouchCapable").mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it("opens the action drawer from a long press on the row's own expand button", () => {
    vi.useFakeTimers()
    const { onToggle } = renderRow({ onNewSubtopic: vi.fn() })
    const rowButton = screen.getByRole("button", { name: /Pierre:/ })

    fireEvent.touchStart(rowButton, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))

    expect(screen.getByRole("button", { name: /New sub-topic/i })).toBeInTheDocument()
    // The synthetic click that follows the hold must not also expand the row.
    fireEvent.click(rowButton)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("still toggles on the next real tap when the hold produced no synthetic click", () => {
    vi.useFakeTimers()
    const { onToggle } = renderRow({ onNewSubtopic: vi.fn() })
    const rowButton = screen.getByRole("button", { name: /Pierre:/ })

    fireEvent.touchStart(rowButton, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))
    fireEvent.touchCancel(rowButton)
    // No click follows this hold (drawer dismissed / touchcancel / scroll-away).
    act(() => vi.advanceTimersByTime(1000))

    fireEvent.click(rowButton)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it("opens only the drawer from a long press on the attachment chip — no gallery", () => {
    vi.useFakeTimers()
    const openMedia = vi.fn()
    vi.spyOn(contextsModule, "useMediaGallery").mockReturnValue({
      mediaAttachmentId: null,
      openMedia,
      closeMedia: vi.fn(),
    })
    const { onToggle } = renderRow({
      onNewSubtopic: vi.fn(),
      message: message({
        attachments: [{ id: "att_pdf", filename: "spec.pdf", mimeType: "application/pdf" } as never],
      }),
    })
    const chip = screen.getByRole("button", { name: "Open 1 attachment" })

    fireEvent.touchStart(chip, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByRole("button", { name: /New sub-topic/i })).toBeInTheDocument()

    fireEvent.click(chip)
    expect(openMedia).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it("leaves a long press on the link chip to the browser", () => {
    vi.useFakeTimers()
    renderRow({
      onNewSubtopic: vi.fn(),
      message: message({
        linkPreviews: [{ url: "https://example.com/x", contentType: "website", title: "Docs" } as never],
      }),
    })

    fireEvent.touchStart(screen.getByRole("link", { name: "Docs" }), { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))

    expect(screen.queryByRole("button", { name: /New sub-topic/i })).not.toBeInTheDocument()
  })
})

describe("LedgerRow revisions", () => {
  it("opens the edit-history dialog from See revisions", async () => {
    const user = userEvent.setup()
    spyOnExport(messageHistoryDialogModule, "MessageHistoryDialog").mockReturnValue((({ open }: { open: boolean }) =>
      open ? <div>stub-history</div> : null) as unknown as typeof messageHistoryDialogModule.MessageHistoryDialog)
    renderRow({ message: message({ editedAt: "2026-07-28T10:30:00.000Z" }) })

    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Pierre:/ }) })
    await user.click(await screen.findByRole("menuitem", { name: /See revisions/i }))

    expect(await screen.findByText("stub-history")).toBeInTheDocument()
  })
})

describe("LedgerRow attachment chip", () => {
  function renderWithGallery(attachment: Record<string, unknown>) {
    const openMedia = vi.fn()
    vi.spyOn(contextsModule, "useMediaGallery").mockReturnValue({
      mediaAttachmentId: null,
      openMedia,
      closeMedia: vi.fn(),
    })
    const rendered = renderRow({ message: message({ attachments: [attachment as never] }) })
    return { ...rendered, openMedia }
  }

  it("opens the gallery for a previewable first attachment", async () => {
    const user = userEvent.setup()
    const { openMedia, onToggle } = renderWithGallery({
      id: "att_pdf",
      filename: "spec.pdf",
      mimeType: "application/pdf",
    })
    await user.click(screen.getByRole("button", { name: "Open 1 attachment" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(openMedia).toHaveBeenCalledWith("att_pdf")
  })

  it("only expands for a file the gallery cannot open — no ?media= param", async () => {
    const user = userEvent.setup()
    const { openMedia, onToggle } = renderWithGallery({
      id: "att_zip",
      filename: "build.zip",
      mimeType: "application/zip",
    })
    await user.click(screen.getByRole("button", { name: "Open 1 attachment" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(openMedia).not.toHaveBeenCalled()
  })

  it("only expands for a video that is still processing", async () => {
    const user = userEvent.setup()
    const { openMedia, onToggle } = renderWithGallery({
      id: "att_vid",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      processingStatus: "pending",
    })
    await user.click(screen.getByRole("button", { name: "Open 1 attachment" }))
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(openMedia).not.toHaveBeenCalled()
  })

  it("opens the gallery for a completed video", async () => {
    const user = userEvent.setup()
    const { openMedia } = renderWithGallery({
      id: "att_vid",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      processingStatus: "completed",
    })
    await user.click(screen.getByRole("button", { name: "Open 1 attachment" }))
    expect(openMedia).toHaveBeenCalledWith("att_vid")
  })
})

describe("LedgerRow narrow viewport", () => {
  it("keeps the native menu and hides the trigger cluster below sm", async () => {
    const user = userEvent.setup()
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
    const { container } = renderRow({ onNewSubtopic: vi.fn() })

    expect(container.querySelector(".reveal-actions-hover-only")).toHaveClass("hidden")
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Pierre:/ }) })
    expect(screen.queryByRole("menuitem", { name: /New sub-topic/i })).not.toBeInTheDocument()
  })

  it("shows the cluster and opens the menu on right-click at sm and up", async () => {
    const user = userEvent.setup()
    vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
    const { container } = renderRow({ onNewSubtopic: vi.fn() })

    expect(container.querySelector(".reveal-actions-hover-only")).not.toHaveClass("hidden")
    await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: /Pierre:/ }) })
    expect(await screen.findByRole("menuitem", { name: /New sub-topic/i })).toBeInTheDocument()
  })
})

describe("LedgerRow settling", () => {
  it("offers the settling pair instead of Move to sub-topic, and wears the settling texture", async () => {
    const user = userEvent.setup()
    const mutate = vi.fn()
    vi.spyOn(conversationsModule, "useSettleConversationMessage").mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof conversationsModule.useSettleConversationMessage>)
    renderRow({ message: message({ settling: true }), onMoveToSubtopic: vi.fn(), onNewSubtopic: vi.fn() })

    const rowButton = screen.getByRole("button", { name: /Pierre:/ })
    expect(rowButton.closest("[data-ledger-row]")).toHaveAttribute("data-settling")
    expect(rowButton.closest("[data-ledger-row]")).toHaveClass("opacity-70")

    await user.pointer({ keys: "[MouseRight]", target: rowButton })
    expect(await screen.findByRole("menuitem", { name: "Keep here" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Not this topic…" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /Move to sub-topic/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole("menuitem", { name: "Keep here" }))
    expect(mutate).toHaveBeenCalledWith({ messageId: "msg_1", conversationId: CONV }, expect.anything())
  })

  it("keeps Move to sub-topic and no settling texture on a settled row", async () => {
    const user = userEvent.setup()
    renderRow({ onMoveToSubtopic: vi.fn(), onNewSubtopic: vi.fn() })
    const rowButton = screen.getByRole("button", { name: /Pierre:/ })
    expect(rowButton.closest("[data-ledger-row]")).not.toHaveAttribute("data-settling")

    await user.pointer({ keys: "[MouseRight]", target: rowButton })
    expect(await screen.findByRole("menuitem", { name: /Move to sub-topic/i })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Keep here" })).not.toBeInTheDocument()
  })
})

describe("LedgerEventGroup", () => {
  const events = [
    { key: "e1", icon: null, label: "memo captured" },
    { key: "e2", icon: null, label: "thread split" },
    { key: "e3", icon: null, label: "call" },
  ]

  it("coalesces to one composite row, expands to the individual rows, and re-coalesces", async () => {
    const user = userEvent.setup()
    render(<LedgerEventGroup events={events} />)
    const summary = screen.getByRole("button", { name: /3 events/ })
    expect(summary).toHaveTextContent("3 events — memo captured · thread split · call")
    await user.click(summary)
    expect(screen.getAllByRole("button")).toHaveLength(3)
    expect(screen.getByText("memo captured")).toBeInTheDocument()
    await user.click(screen.getByText("thread split"))
    expect(screen.getByRole("button", { name: /3 events/ })).toBeInTheDocument()
  })
})
