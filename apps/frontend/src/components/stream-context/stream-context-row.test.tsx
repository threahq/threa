import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, useLocation } from "react-router-dom"
import { StreamContextRow } from "./stream-context-row"
import * as hooks from "@/hooks"
import type {
  ContextItem,
  DelegationContextItem,
  FileContextItem,
  LinkContextItem,
  MediaContextItem,
} from "@/lib/stream-context/types"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooks, "useFormattedDate").mockReturnValue({
    formatRelative: () => "now",
  } as unknown as ReturnType<typeof hooks.useFormattedDate>)
})

function linkItem(url: string, overrides: Partial<LinkContextItem> = {}): LinkContextItem {
  return {
    key: `link:${url}`,
    category: "link",
    createdAt: "2026-06-24T10:00:00.000Z",
    sourceMessageId: "msg_1",
    snippet: "",
    url,
    title: "A link",
    siteName: null,
    faviconUrl: null,
    imageUrl: null,
    previewKind: "generic",
    badge: null,
    refCount: 1,
    ...overrides,
  }
}

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{`${loc.pathname}${loc.search}`}</div>
}

function renderRow(item: ContextItem) {
  const onOpenGallery = vi.fn()
  const onJumpToMessage = vi.fn()
  render(
    <MemoryRouter initialEntries={["/start"]}>
      <StreamContextRow
        workspaceId="ws_1"
        item={item}
        onJumpToMessage={onJumpToMessage}
        onOpenThread={vi.fn()}
        onOpenMemo={vi.fn()}
        onOpenGallery={onOpenGallery}
      />
      <LocationProbe />
    </MemoryRouter>
  )
  return { onOpenGallery, onJumpToMessage }
}

const itemBase = { createdAt: "2026-06-24T10:00:00.000Z", sourceMessageId: "msg_1", snippet: "" }

function mediaItem(overrides: Partial<MediaContextItem> = {}): MediaContextItem {
  return {
    ...itemBase,
    key: "media:att_img",
    category: "media",
    mediaKind: "image",
    attachmentId: "att_img",
    giphyUrl: null,
    filename: "shot.png",
    ...overrides,
  }
}

function fileItem(overrides: Partial<FileContextItem> = {}): FileContextItem {
  return {
    ...itemBase,
    key: "file:att_pdf",
    category: "file",
    attachmentId: "att_pdf",
    fileCategory: "pdf",
    mimeType: "application/pdf",
    filename: "spec.pdf",
    sizeBytes: 10,
    ...overrides,
  }
}

function delegationItem(overrides: Partial<DelegationContextItem> = {}): DelegationContextItem {
  return {
    ...itemBase,
    key: "delegation:dlg_1",
    category: "delegation",
    sourceMessageId: "event_created_1",
    delegationId: "dlg_1",
    title: "Add rate limiting",
    status: "running",
    claimedByLabel: "Kris's MacBook",
    statusNote: "Installing dependencies",
    resultMessageId: null,
    ...overrides,
  }
}

describe("StreamContextRow delegation", () => {
  it("shows title, live status pill, and claim details; primary jumps to the card's event", async () => {
    const { onJumpToMessage } = renderRow(delegationItem())

    expect(screen.getByText("Add rate limiting")).toBeInTheDocument()
    expect(screen.getByText("Running")).toBeInTheDocument()
    expect(screen.getByText("Kris's MacBook · Installing dependencies")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /go to delegation add rate limiting/i }))
    expect(onJumpToMessage).toHaveBeenCalledWith("event_created_1")
  })

  it("falls back to a generic secondary line when nothing has claimed it", () => {
    renderRow(delegationItem({ status: "open", claimedByLabel: null, statusNote: null }))
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(screen.getByText("Delegated task")).toBeInTheDocument()
  })
})

describe("StreamContextRow link", () => {
  const origin = window.location.origin

  it("routes a same-origin link in-app (no new tab) and navigates on click", async () => {
    renderRow(linkItem(`${origin}/w/ws_1/s/stream_2?m=msg_3`))

    const anchor = screen.getByRole("link", { name: /open a link/i })
    expect(anchor).toHaveAttribute("href", "/w/ws_1/s/stream_2?m=msg_3")
    expect(anchor).not.toHaveAttribute("target")

    await userEvent.click(anchor)
    expect(screen.getByTestId("location")).toHaveTextContent("/w/ws_1/s/stream_2?m=msg_3")
  })

  it("opens an external link in a new tab and does not navigate in-app", async () => {
    renderRow(linkItem("https://github.com/acme/repo/pull/42"))

    const anchor = screen.getByRole("link", { name: /open a link/i })
    expect(anchor).toHaveAttribute("href", "https://github.com/acme/repo/pull/42")
    expect(anchor).toHaveAttribute("target", "_blank")
    expect(anchor).toHaveAttribute("rel", expect.stringContaining("noopener"))
    expect(screen.getByTestId("location")).toHaveTextContent("/start")
  })
})

describe("StreamContextRow gallery open", () => {
  it("opens an uploaded media item in the gallery by attachment id", async () => {
    const { onOpenGallery } = renderRow(mediaItem())
    await userEvent.click(screen.getByRole("button", { name: /open shot\.png/i }))
    expect(onOpenGallery).toHaveBeenCalledWith("att_img")
  })

  it("opens an inline Giphy item in the gallery by its sentinel key", async () => {
    const { onOpenGallery } = renderRow(
      mediaItem({
        key: "media:giphy",
        mediaKind: "gif",
        attachmentId: null,
        giphyUrl: "https://media.giphy.com/media/abc/giphy.gif",
        filename: "party",
      })
    )
    await userEvent.click(screen.getByRole("button", { name: /open party/i }))
    expect(onOpenGallery).toHaveBeenCalledWith("giphy:https://media.giphy.com/media/abc/giphy.gif")
  })

  it("opens a previewable file (pdf) in the gallery", async () => {
    const { onOpenGallery, onJumpToMessage } = renderRow(fileItem())
    await userEvent.click(screen.getByRole("button", { name: /open spec\.pdf/i }))
    expect(onOpenGallery).toHaveBeenCalledWith("att_pdf")
    expect(onJumpToMessage).not.toHaveBeenCalled()
  })

  it("jumps to the message for a non-previewable file instead of opening the gallery", async () => {
    const { onOpenGallery, onJumpToMessage } = renderRow(
      fileItem({ fileCategory: "archive", mimeType: "application/zip", filename: "bundle.zip" })
    )
    await userEvent.click(screen.getByRole("button", { name: /go to message with bundle\.zip/i }))
    expect(onJumpToMessage).toHaveBeenCalledWith("msg_1")
    expect(onOpenGallery).not.toHaveBeenCalled()
  })
})
