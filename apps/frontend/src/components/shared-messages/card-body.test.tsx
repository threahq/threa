import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"
import { MediaGalleryProvider } from "@/contexts"
import { SharedMessageCardBody } from "./card-body"
import type { AttachmentSummary } from "@threahq/types"
import type { SharedMessageSource } from "@/hooks/use-shared-message-source"

function renderUnderRoute(node: ReactNode, initialPath = "/w/ws_1/s/current") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        {/* The attachment row resolves presigned URLs through the gallery
            context, exactly as both card surfaces mount it in the app. */}
        <Route path="/w/:workspaceId/s/:streamId" element={<MediaGalleryProvider>{node}</MediaGalleryProvider>} />
      </Routes>
    </MemoryRouter>
  )
}

describe("SharedMessageCardBody — Slice 2 placeholders", () => {
  it("renders the privacy stub for the private state, leaking only kind + visibility", () => {
    const source: SharedMessageSource = {
      status: "private",
      sourceStreamKind: "channel",
      sourceVisibility: "private",
    }
    renderUnderRoute(<SharedMessageCardBody source={source} fallbackAuthor="Should not appear" />)

    // The stub must NOT surface the cached fallback author (privacy leak).
    expect(screen.queryByText("Should not appear")).not.toBeInTheDocument()
    expect(screen.getByText("Private message")).toBeInTheDocument()
    expect(screen.getByText(/references content in a private channel you don't have access to/i)).toBeInTheDocument()
  })

  it("uses 'DM' wording for dm sources", () => {
    const source: SharedMessageSource = {
      status: "private",
      sourceStreamKind: "dm",
      sourceVisibility: "private",
    }
    renderUnderRoute(<SharedMessageCardBody source={source} fallbackAuthor="" />)
    expect(screen.getByText(/private DM you don't have access to/i)).toBeInTheDocument()
  })

  it("renders a navigable link for the truncated state", () => {
    const source: SharedMessageSource = {
      status: "truncated",
      streamId: "stream_deep",
      messageId: "msg_deep",
    }
    renderUnderRoute(<SharedMessageCardBody source={source} fallbackAuthor="" />)

    const link = screen.getByRole("link", { name: /open in source stream/i })
    expect(link.getAttribute("href")).toBe("/w/ws_1/s/stream_deep?m=msg_deep")
  })
})

const RESOLVED: SharedMessageSource = {
  status: "resolved",
  contentMarkdown: "the pinned body",
  authorId: "usr_1",
  actorType: "user",
  authorName: "Ada",
  editedAt: null,
  attachments: [],
  version: 2,
  currentRevision: 2,
  range: null,
}

describe("SharedMessageCardBody — pinned references", () => {
  it("links to the source when it was edited after the share was pinned", () => {
    renderUnderRoute(
      <SharedMessageCardBody
        source={{ ...RESOLVED, currentRevision: 3 }}
        fallbackAuthor=""
        sourceHref="/w/ws_1/s/stream_src?m=msg_1"
      />
    )

    const link = screen.getByRole("link", { name: /edited since/i })
    expect(link.getAttribute("href")).toBe("/w/ws_1/s/stream_src?m=msg_1")
    // The card still shows what was pinned, not what the source reads now.
    expect(screen.getByText("the pinned body")).toBeInTheDocument()
  })

  it("says nothing when the source still reads as it was pinned", () => {
    renderUnderRoute(<SharedMessageCardBody source={RESOLVED} fallbackAuthor="" sourceHref="/w/ws_1/s/s?m=m" />)
    expect(screen.queryByText(/edited since/i)).not.toBeInTheDocument()
  })

  it("marks the edit as text where the card itself is already the link", () => {
    renderUnderRoute(<SharedMessageCardBody source={{ ...RESOLVED, currentRevision: 3 }} fallbackAuthor="" />)
    expect(screen.getByText(/edited since/i)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /edited since/i })).not.toBeInTheDocument()
  })

  it("drops the attachments row on a ranged share", () => {
    const attachments: AttachmentSummary[] = [
      { id: "att_1", filename: "plan.pdf", mimeType: "application/pdf", sizeBytes: 10 },
    ]

    const whole = renderUnderRoute(<SharedMessageCardBody source={{ ...RESOLVED, attachments }} fallbackAuthor="" />)
    expect(whole.container.textContent).toContain("plan.pdf")
    whole.unmount()

    const ranged = renderUnderRoute(
      <SharedMessageCardBody source={{ ...RESOLVED, attachments, range: { from: 1, to: 4 } }} fallbackAuthor="" />
    )
    expect(ranged.container.textContent).not.toContain("plan.pdf")
  })
})
