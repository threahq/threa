import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { linkPreviewsApi } from "@/api"
import { ComposerLinkPreviews } from "./composer-link-previews"
import type { JSONContent } from "@threa/types"

const origin = window.location.origin

function draftWithLink(href: string): JSONContent {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "see this", marks: [{ type: "link", attrs: { href } }] }] },
    ],
  }
}

describe("ComposerLinkPreviews", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("resolves an in-app link in the draft via the by-url endpoint", async () => {
    const resolve = vi
      .spyOn(linkPreviewsApi, "resolveInAppLinkByUrl")
      .mockResolvedValue({
        kind: "stream",
        accessTier: "full",
        streamName: "design",
        streamType: "channel",
        visibility: "public",
      })

    const url = `${origin}/w/ws_1/s/stream_1`
    render(
      <MemoryRouter>
        <ComposerLinkPreviews content={draftWithLink(url)} workspaceId="ws_1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText("design")).toBeInTheDocument())
    expect(resolve).toHaveBeenCalledWith("ws_1", url)
  })

  it("renders nothing when the draft has no in-app links", async () => {
    const resolve = vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "stream",
      accessTier: "full",
    })

    const { container } = render(
      <MemoryRouter>
        <ComposerLinkPreviews content={draftWithLink("https://example.com/post")} workspaceId="ws_1" />
      </MemoryRouter>
    )

    // Give the debounce a chance to fire; nothing should resolve or render.
    await new Promise((r) => setTimeout(r, 500))
    expect(resolve).not.toHaveBeenCalled()
    expect(container).toBeEmptyDOMElement()
  })
})
