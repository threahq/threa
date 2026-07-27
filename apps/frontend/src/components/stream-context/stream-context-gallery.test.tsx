import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real read path
import { db } from "@/db"
import * as imageGallery from "@/components/image-gallery"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { StreamContextGallery } from "./stream-context-gallery"

const WS = "ws_1"
const STREAM = "stream_root"
const THREAD = "stream_thread"

/** A stand-in for the real gallery chrome: this test is about the item SET. */
function GalleryProbe({ isOpen, items }: { isOpen: boolean; items: { attachmentId: string }[] }) {
  return (
    <div data-testid="gallery" data-open={String(isOpen)}>
      {items.map((i) => (
        <span key={i.attachmentId}>{i.attachmentId}</span>
      ))}
    </div>
  )
}

function renderGallery(selectedKey: string, flag: "on" | "off" = "on") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(workspaceKeys.bootstrap(WS), {
    featureFlags: { workspace: { streamContextIndex: flag }, user: {} },
  })
  render(
    <MemoryRouter initialEntries={["/s"]}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <StreamContextGallery
            workspaceId={WS}
            streamId={STREAM}
            selectedKey={selectedKey}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.spyOn(imageGallery, "MediaGallery").mockImplementation(GalleryProbe as unknown as typeof imageGallery.MediaGallery)
  await db.streamContextItems.clear()
  await db.events.clear()
  await db.streams.clear()
  await db.streams.put({ id: STREAM, workspaceId: WS, rootStreamId: null } as never)
})

describe("StreamContextGallery — indexed", () => {
  it("opens on an indexed row whose message is outside the loaded event window", async () => {
    // A thread's image, indexed under the root's tree scope — never present in
    // `useStreamEvents(STREAM)`, so the derive path could not open it.
    await db.streamContextItems.put({
      key: "media:att_old:msg_old",
      workspaceId: WS,
      streamId: THREAD,
      rootStreamId: STREAM,
      category: "media",
      refKind: "attachment",
      refId: "att_old",
      groupKey: "att_old",
      groupRef: "media:att_old",
      sourceMessageId: "msg_old",
      authorId: "usr_1",
      occurredAt: "2026-06-20T10:00:00.000Z",
      sequence: "1",
      snippet: "",
      occurrenceCount: 1,
      detail: { attachmentId: "att_old", mediaKind: "image", filename: "old.png", mimeType: "image/png" },
      _cachedAt: Date.now(),
    } as never)

    renderGallery("att_old")

    await waitFor(() => expect(screen.getByTestId("gallery")).toHaveAttribute("data-open", "true"))
    expect(screen.getByText("att_old")).toBeInTheDocument()
  })

  it("stays on the derive path when the flag is off", async () => {
    await db.streamContextItems.put({
      key: "media:att_old:msg_old",
      workspaceId: WS,
      streamId: STREAM,
      rootStreamId: STREAM,
      category: "media",
      refKind: "attachment",
      refId: "att_old",
      groupKey: "att_old",
      groupRef: "media:att_old",
      sourceMessageId: "msg_old",
      authorId: "usr_1",
      occurredAt: "2026-06-20T10:00:00.000Z",
      sequence: "1",
      snippet: "",
      occurrenceCount: 1,
      detail: { attachmentId: "att_old", mediaKind: "image", filename: "old.png", mimeType: "image/png" },
      _cachedAt: Date.now(),
    } as never)

    renderGallery("att_old", "off")

    await waitFor(() => expect(screen.getByTestId("gallery")).toHaveAttribute("data-open", "false"))
  })
})
