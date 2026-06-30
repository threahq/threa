import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { linkPreviewsApi } from "@/api"
import { db } from "@/db"
import * as workspaceStore from "@/stores/workspace-store"
import * as currentUserModule from "@/hooks/use-current-workspace-user-id"

const origin = window.location.origin

function seedStreams(streams: Array<Record<string, unknown>>) {
  vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue(
    streams as unknown as ReturnType<typeof workspaceStore.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStore, "useWorkspaceUsers").mockReturnValue([])
  vi.spyOn(workspaceStore, "useWorkspaceDmPeers").mockReturnValue([])
}

function renderMarkdown(content: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_here"]}>
        <Routes>
          <Route path="/w/:workspaceId/s/:streamId" element={<MarkdownContent content={content} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MarkdownContent — inline in-app link chip", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // The chip resolves the viewer via auth; stub it so the markdown tree
    // doesn't require an AuthProvider.
    vi.spyOn(currentUserModule, "useCurrentWorkspaceUserId").mockReturnValue("user_viewer")
  })

  afterEach(async () => {
    await db.events.clear()
  })

  it("renders an in-app stream link as an inline chip named by the local cache, not the link text", () => {
    seedStreams([{ id: "stream_1", type: "channel", slug: "design", displayName: null }])
    const url = `${origin}/w/ws_1/s/stream_1`
    renderMarkdown(`see [whatever](${url}) here`)

    // Local cache wins over the markdown link text. The channel renders
    // mention-style — `#` prefix + bare slug — so it reads "#design" once (not a
    // doubled "# #design").
    const link = screen.getByRole("link", { name: "#design" })
    expect(link).toHaveAttribute("href", url)
    expect(screen.queryByText("whatever")).not.toBeInTheDocument()
  })

  it("shows a deleted message link as restricted even when its parent stream is cached", async () => {
    // The local cache names the parent stream, but only the backend knows the
    // message itself was deleted — so a message link must still resolve.
    seedStreams([{ id: "stream_1", type: "channel", slug: "design", displayName: null }])
    const resolve = vi
      .spyOn(linkPreviewsApi, "resolveInAppLinkByUrl")
      .mockResolvedValue({ kind: "message", accessTier: "full", deleted: true })

    const url = `${origin}/w/ws_1/s/stream_1?m=msg_9`
    renderMarkdown(`see [whatever](${url})`)

    await waitFor(() => expect(screen.getByText("Deleted message")).toBeInTheDocument())
    expect(resolve).toHaveBeenCalledWith("ws_1", url)
    expect(screen.queryByText("#design")).not.toBeInTheDocument()
  })

  it("resolves a cached channel message from the local timeline, naming author + location, without a backend resolve", async () => {
    vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue([
      { id: "stream_1", type: "channel", slug: "design", displayName: null },
    ] as unknown as ReturnType<typeof workspaceStore.useWorkspaceStreams>)
    vi.spyOn(workspaceStore, "useWorkspaceUsers").mockReturnValue([
      { id: "user_pierre", name: "Pierre Boberg", workosUserId: "wos_pierre", avatarUrl: null },
    ] as never)
    vi.spyOn(workspaceStore, "useWorkspaceDmPeers").mockReturnValue([])
    const resolve = vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl")
    await db.events.add({
      id: "evt_live",
      workspaceId: "ws_1",
      streamId: "stream_1",
      eventType: "message_created",
      actorId: "user_pierre",
      actorType: "user",
      sequence: 1,
      payload: { messageId: "msg_2", contentMarkdown: "hi" },
      _cachedAt: 0,
    } as never)

    const url = `${origin}/w/ws_1/s/stream_1?m=msg_2`
    renderMarkdown(`see [whatever](${url})`)

    // Author + location resolve straight from the cached event; the
    // permission-checked backend resolver is never called.
    await waitFor(() => expect(screen.getByText("Pierre Boberg in #design")).toBeInTheDocument())
    expect(resolve).not.toHaveBeenCalled()
  })

  it("shows a locally-deleted message as restricted from its tombstone, without a backend resolve", async () => {
    // A delete stamps `deletedAt` onto the cached create row, so the tombstone is
    // local — the chip must read it rather than render a live chip or round-trip.
    seedStreams([{ id: "stream_1", type: "channel", slug: "design", displayName: null }])
    const resolve = vi.spyOn(linkPreviewsApi, "resolveInAppLinkByUrl")
    await db.events.add({
      id: "evt_del",
      workspaceId: "ws_1",
      streamId: "stream_1",
      eventType: "message_created",
      actorId: "user_pierre",
      actorType: "user",
      sequence: 1,
      payload: { messageId: "msg_9", contentMarkdown: "hi", deletedAt: "2026-06-29T00:00:00.000Z" },
      _cachedAt: 0,
    } as never)

    const url = `${origin}/w/ws_1/s/stream_1?m=msg_9`
    renderMarkdown(`see [whatever](${url})`)

    await waitFor(() => expect(screen.getByText("Deleted message")).toBeInTheDocument())
    expect(resolve).not.toHaveBeenCalled()
  })

  it("leaves a plain web link as an anchor showing its own link text", () => {
    seedStreams([])
    renderMarkdown("read [the blog](https://example.com/post)")

    // Web links aren't resolved/chipped — the visible text stays the link text.
    expect(screen.getByRole("link", { name: "the blog" })).toHaveAttribute("href", "https://example.com/post")
  })
})
