import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { linkPreviewsApi } from "@/api"
import { ComposerLinkPreviews } from "./composer-link-previews"
import type { JSONContent } from "@threa/types"

const origin = window.location.origin

function draft(...inline: JSONContent[]): JSONContent {
  return { type: "doc", content: [{ type: "paragraph", content: inline }] }
}

function link(text: string, href: string): JSONContent {
  return { type: "text", text, marks: [{ type: "link", attrs: { href } }] }
}

describe("ComposerLinkPreviews", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("chips a web link by its host without any resolve call", async () => {
    const resolve = vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl")
    render(
      <MemoryRouter>
        <ComposerLinkPreviews content={draft(link("blog", "https://www.example.com/post"))} workspaceId="ws_1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText("example.com")).toBeInTheDocument())
    expect(resolve).not.toHaveBeenCalled()
  })

  it("chips an in-app stream link by its resolved name when not cached locally", async () => {
    // Empty workspace store in tests → local name is null → backend resolve fallback.
    const resolve = vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({
      kind: "stream",
      accessTier: "full",
      streamName: "design",
      streamType: "channel",
      visibility: "public",
    })

    const url = `${origin}/w/ws_1/s/stream_1`
    render(
      <MemoryRouter>
        <ComposerLinkPreviews content={draft(link("chan", url))} workspaceId="ws_1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText("design")).toBeInTheDocument())
    expect(resolve).toHaveBeenCalledWith("ws_1", url)
  })

  it("chips a restricted in-app link as private without leaking a name", async () => {
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl").mockResolvedValue({ kind: "stream", accessTier: "private" })

    render(
      <MemoryRouter>
        <ComposerLinkPreviews content={draft(link("x", `${origin}/w/ws_1/s/secret_1`))} workspaceId="ws_1" />
      </MemoryRouter>
    )

    await waitFor(() => expect(screen.getByText("Private conversation")).toBeInTheDocument())
  })

  it("forgets a dismissal once the link leaves and re-enters the draft", async () => {
    vi.useFakeTimers()
    vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl")
    const url = "https://example.com/post"
    const withLink = (
      <MemoryRouter>
        <ComposerLinkPreviews content={draft(link("blog", url))} workspaceId="ws_1" />
      </MemoryRouter>
    )
    const noLink = (
      <MemoryRouter>
        <ComposerLinkPreviews content={draft({ type: "text", text: "no link now" })} workspaceId="ws_1" />
      </MemoryRouter>
    )
    // Drain the debounce timer and the pruning effect it cascades into, without
    // burning real wall-clock time. `act` flushes the chained state updates.
    const settle = () => act(async () => void (await vi.runAllTimersAsync()))

    const { rerender } = render(withLink)
    await settle()
    fireEvent.click(screen.getByLabelText("Hide link"))
    expect(screen.queryByText("example.com")).not.toBeInTheDocument()

    // Link leaves the draft → the empty draft settles and the dismissal is pruned.
    rerender(noLink)
    await settle()
    expect(screen.queryByText("example.com")).not.toBeInTheDocument()

    // Re-adding the same link chips it again rather than staying dismissed.
    rerender(withLink)
    await settle()
    expect(screen.getByText("example.com")).toBeInTheDocument()
  })

  it("renders nothing when the draft has no links", () => {
    const { container } = render(
      <MemoryRouter>
        <ComposerLinkPreviews content={draft({ type: "text", text: "no links here" })} workspaceId="ws_1" />
      </MemoryRouter>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
