import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { linkPreviewsApi } from "@/api"
import * as contextsModule from "@/contexts"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"
import { LinkPreviewList } from "./link-preview-list"
import type { LinkPreviewSummary } from "@threahq/types"

function renderList(previews: LinkPreviewSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LinkPreviewList workspaceId="ws_123" messageId="msg_123" previews={previews} />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const mockGetForMessage = vi.fn()
const mockDismiss = vi.fn()

describe("LinkPreviewList", () => {
  const preview: LinkPreviewSummary = {
    id: "preview_1",
    url: "https://example.com/article",
    title: "Preview title",
    description: "Preview description",
    imageUrl: null,
    faviconUrl: null,
    siteName: "Example",
    contentType: "website",
    position: 0,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    __resetCollapseCacheForTests()
    mockGetForMessage.mockReset()
    mockDismiss.mockReset()
    mockDismiss.mockResolvedValue(undefined)

    vi.spyOn(linkPreviewsApi, "getForMessage").mockImplementation(
      (...args: Parameters<typeof linkPreviewsApi.getForMessage>) => mockGetForMessage(...args)
    )
    vi.spyOn(linkPreviewsApi, "dismiss").mockImplementation((...args: Parameters<typeof linkPreviewsApi.dismiss>) =>
      mockDismiss(...args)
    )
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "open" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(null as ReturnType<typeof contextsModule.useSocket>)
  })

  it("renders previews from the event payload without fetching per-message preview data", () => {
    render(<LinkPreviewList workspaceId="ws_123" messageId="msg_123" previews={[preview]} />)

    expect(screen.getByText("Preview title")).toBeInTheDocument()
    expect(mockGetForMessage).not.toHaveBeenCalled()
  })

  it("suppresses a stream_link card (it renders as an inline chip instead) but keeps web previews", () => {
    const streamPreview: LinkPreviewSummary = { ...preview, id: "p_stream", contentType: "stream_link" }
    renderList([streamPreview, preview])

    // The stream link has no card; the web preview in the same message still does.
    expect(screen.getByText("Preview title")).toBeInTheDocument()
  })

  it("keeps a message_link card — the inline chip is the body reference, the card is the preview below", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLink").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      deleted: true,
    })
    const messagePreview: LinkPreviewSummary = {
      ...preview,
      id: "p_msg",
      contentType: "message_link",
      url: "https://app.threa.io/w/ws_123/s/stream_1?m=msg_9",
    }
    renderList([messagePreview])

    await waitFor(() => expect(screen.getByText("This message was deleted")).toBeInTheDocument())
  })

  const many = [0, 1, 2, 3, 4].map(
    (i): LinkPreviewSummary => ({
      ...preview,
      id: `p_${i}`,
      url: `https://example.com/${i}`,
      title: `Title ${i}`,
      description: `Description ${i}`,
    })
  )

  it("opens a lone preview as a full card", () => {
    renderList([preview])

    expect(screen.getByText("Preview description")).toBeInTheDocument()
    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument()
  })

  it("folds an open preview from its header title, not just the chevron", async () => {
    const user = userEvent.setup()
    renderList([preview])

    await user.click(screen.getByRole("button", { name: "Example", expanded: true }))

    expect(screen.queryByText("Preview description")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview title" })).toHaveAttribute("aria-expanded", "false")
  })

  it("opens the first three previews and folds the rest to chips", () => {
    renderList(many)

    for (let i = 0; i < 3; i++) expect(screen.getByText(`Description ${i}`)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Title 3" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "Title 4" })).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/more preview/)).not.toBeInTheDocument()
  })

  it("folds a lone preview when the preference says collapsed", () => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "collapsed" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    renderList([preview])

    expect(screen.queryByText("Preview description")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview title" })).toBeInTheDocument()
  })

  it("keeps an opened chip open across a remount", async () => {
    const user = userEvent.setup()
    const { unmount } = renderList(many)

    await user.click(screen.getByRole("button", { name: "Title 3" }))
    expect(screen.getByText("Description 3")).toBeInTheDocument()
    expect(screen.queryByText("Description 4")).not.toBeInTheDocument()

    unmount()
    renderList(many)

    expect(screen.getByText("Description 3")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Title 4" })).toHaveAttribute("aria-expanded", "false")
  })

  it("keeps a lone web preview open next to an in-app card", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLink").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      deleted: true,
    })
    const messagePreview: LinkPreviewSummary = {
      ...preview,
      id: "p_msg",
      contentType: "message_link",
      url: "https://app.threa.io/w/ws_123/s/stream_1?m=msg_9",
    }
    renderList([messagePreview, preview])

    expect(screen.getByText("Preview description")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("This message was deleted")).toBeInTheDocument())
  })

  it("caps in-app cards but not the folded web chips beside them", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLink").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      deleted: true,
    })
    const cards = [0, 1, 2, 3].map(
      (i): LinkPreviewSummary => ({
        ...preview,
        id: `p_msg_${i}`,
        contentType: "message_link",
        url: `https://app.threa.io/w/ws_123/s/stream_1?m=msg_${i}`,
      })
    )
    const chips = [0, 1].map((i) => ({ ...preview, id: `p_web_${i}`, title: `Web ${i}` }))
    renderList([...cards, ...chips])

    await waitFor(() => expect(screen.getAllByText("This message was deleted")).toHaveLength(3))
    expect(screen.getByRole("button", { name: "Web 0" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Web 1" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show 1 more preview" })).toBeInTheDocument()
  })

  it("shows every chip without the three-preview cap when the preference says collapsed", () => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "collapsed" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    const { container } = renderList(many)

    for (let i = 0; i < 5; i++) {
      expect(within(container).getByRole("button", { name: `Title ${i}` })).toBeInTheDocument()
    }
    expect(screen.queryByText(/more preview/)).not.toBeInTheDocument()
  })
})
