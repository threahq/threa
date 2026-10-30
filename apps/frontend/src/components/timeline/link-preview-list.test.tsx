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

function toggleForTitle(title: string) {
  return within(
    screen.getByRole("link", { name: title }).closest('[data-native-context="true"]') as HTMLElement
  ).getByRole("button", { name: /^(Expand|Collapse) preview$/ })
}

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

  it("should suppress the card of a same-origin /go link, which renders as a chip", () => {
    const goPreview: LinkPreviewSummary = {
      ...preview,
      id: "p_go",
      url: `${window.location.origin}/go/settings/ai`,
      title: "App page title",
    }
    renderList([goPreview, preview])

    expect(screen.queryByText("App page title")).toBeNull()
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
    expect(screen.getByRole("button", { name: "Collapse preview" })).toBeInTheDocument()
  })

  it("should open the first three previews and collapse the rest", () => {
    renderList(many)

    for (let i = 0; i < 3; i++) expect(toggleForTitle(`Title ${i}`)).toHaveAttribute("aria-expanded", "true")
    expect(toggleForTitle("Title 3")).toHaveAttribute("aria-expanded", "false")
    expect(toggleForTitle("Title 4")).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByText(/more preview/)).not.toBeInTheDocument()
  })

  it("folds a lone preview when the preference says collapsed", () => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "collapsed" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    renderList([preview])

    expect(screen.getByText("Preview description")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Preview title" })).toBeInTheDocument()
    expect(toggleForTitle("Preview title")).toHaveAttribute("aria-expanded", "false")
  })

  it("should preserve a manually opened preview across remount and default changes", async () => {
    const user = userEvent.setup()
    const { unmount } = renderList(many)

    await user.click(toggleForTitle("Title 3"))
    expect(toggleForTitle("Title 3")).toHaveAttribute("aria-expanded", "true")
    expect(toggleForTitle("Title 4")).toHaveAttribute("aria-expanded", "false")

    unmount()
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "collapsed" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    renderList(many)

    expect(toggleForTitle("Title 3")).toHaveAttribute("aria-expanded", "true")
    expect(toggleForTitle("Title 4")).toHaveAttribute("aria-expanded", "false")
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

    expect(toggleForTitle("Preview title")).toHaveAttribute("aria-expanded", "true")
    await waitFor(() => expect(screen.getByText("This message was deleted")).toBeInTheDocument())
  })

  it("should cap internal cards independently of open web previews", async () => {
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
    const websites = [0, 1].map((i) => ({ ...preview, id: `p_web_${i}`, title: `Web ${i}` }))
    renderList([...cards, ...websites])

    await waitFor(() => expect(screen.getAllByText("This message was deleted")).toHaveLength(3))
    expect(toggleForTitle("Web 0")).toHaveAttribute("aria-expanded", "true")
    expect(toggleForTitle("Web 1")).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByRole("button", { name: "Show 1 more preview" })).toBeInTheDocument()
  })

  it("should show every collapsed row without a cap when the preference says collapsed", () => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { linkPreviewDefault: "collapsed" },
    } as ReturnType<typeof contextsModule.usePreferences>)
    renderList(many)

    for (let i = 0; i < 5; i++) {
      expect(toggleForTitle(`Title ${i}`)).toHaveAttribute("aria-expanded", "false")
    }
    expect(screen.queryByText(/more preview/)).not.toBeInTheDocument()
  })
})
