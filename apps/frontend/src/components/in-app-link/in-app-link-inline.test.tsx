import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { linkPreviewsApi } from "@/api"
import { InAppLinkInline } from "./in-app-link-inline"

const origin = window.location.origin

function renderMessageLink(streamId: string) {
  const href = `${origin}/w/ws_1/s/${streamId}?m=msg_1`
  return render(
    <MemoryRouter>
      <InAppLinkInline href={href} workspaceId="ws_1" streamId={streamId} messageId="msg_1" fallbackLabel="" />
    </MemoryRouter>
  )
}

describe("InAppLinkInline (message chip)", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a DM message as '{author} to {recipient}', collapsing the viewer to 'You'", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      authorName: "Pierre Boberg",
      streamType: "dm",
      recipientName: "Kristoffer Remback",
      recipientIsSelf: true,
    })

    renderMessageLink("stream_dm")

    const chip = await screen.findByText("Pierre Boberg to You")
    expect(chip.closest("a")).toHaveAttribute("href", `${origin}/w/ws_1/s/stream_dm?m=msg_1`)
  })

  it("renders a channel message as '{author} in #slug'", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      authorName: "Kristoffer Remback",
      streamType: "channel",
      streamName: "tech-big-new-prop",
    })

    renderMessageLink("stream_1")

    await waitFor(() => expect(screen.getByText("Kristoffer Remback in #tech-big-new-prop")).toBeInTheDocument())
  })

  it("shows a deleted-message placeholder instead of a live chip", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "message",
      accessTier: "full",
      deleted: true,
    })

    renderMessageLink("stream_1")

    await waitFor(() => expect(screen.getByText("Deleted message")).toBeInTheDocument())
  })
})
