import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { linkPreviewsApi } from "@/api"
import * as contextsModule from "@/contexts"
import { LinkPreviewList } from "./link-preview-list"
import type { LinkPreviewSummary } from "@threa/types"

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

  it("suppresses stream_link / message_link cards (they render as inline chips instead)", () => {
    const streamPreview: LinkPreviewSummary = { ...preview, id: "p_stream", contentType: "stream_link" }
    const messagePreview: LinkPreviewSummary = { ...preview, id: "p_msg", contentType: "message_link" }
    const { container } = render(
      <LinkPreviewList workspaceId="ws_123" messageId="msg_123" previews={[streamPreview, messagePreview]} />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it("keeps web previews while suppressing an in-app stream link in the same message", () => {
    const streamPreview: LinkPreviewSummary = { ...preview, id: "p_stream", contentType: "stream_link" }
    render(<LinkPreviewList workspaceId="ws_123" messageId="msg_123" previews={[streamPreview, preview]} />)

    expect(screen.getByText("Preview title")).toBeInTheDocument()
  })
})
