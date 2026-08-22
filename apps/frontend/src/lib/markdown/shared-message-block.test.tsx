import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { sharedMessageSlotKey } from "@threa/types"
import { SlotsProvider } from "@/components/slots/context"
import { db } from "@/db"

function renderMarkdown(content: string, slotMap: Parameters<typeof SlotsProvider>[0]["map"] = null) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_dst"]}>
      <Routes>
        <Route
          path="/w/:workspaceId/s/:streamId"
          element={
            <SlotsProvider map={slotMap}>
              <MarkdownContent content={content} />
            </SlotsProvider>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

describe("MarkdownContent — sharedMessage paragraph swap", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await db.events.clear()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await db.events.clear()
  })

  it("replaces the 'Shared a message from X' paragraph with a pointer card", () => {
    const markdown = "Shared a message from [Ariadne](shared-message:stream_src/msg_abc)"
    renderMarkdown(markdown)

    const card = document.querySelector('[data-type="shared-message"]')
    expect(card).not.toBeNull()
    // The raw "Shared a message from" prose is gone — only the author label remains.
    expect(screen.queryByText(/Shared a message from/)).toBeNull()
    expect(screen.getByText("Ariadne")).toBeInTheDocument()
  })

  it("does NOT swap a mixed paragraph that only contains a shared-message link in the middle", () => {
    // A user could legitimately type "FYI Shared a message from [Alice](shared-message:s/m)"
    // by hand. The serializer never produces that shape, so the pointer-block
    // swap must not trigger or the surrounding "FYI " text gets dropped.
    const markdown = "FYI Shared a message from [Alice](shared-message:stream_src/msg_abc)"
    renderMarkdown(markdown)

    expect(document.querySelector('[data-type="shared-message"]')).toBeNull()
    expect(screen.getByText(/FYI Shared a message from/)).toBeInTheDocument()
  })

  it("renders the source message body when the hydration map has an ok entry", () => {
    const markdown = "Shared a message from [Ariadne](shared-message:stream_src/msg_abc)"
    renderMarkdown(markdown, {
      [sharedMessageSlotKey("msg_abc")]: {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_abc",
        streamId: "stream_src",
        authorId: "usr_1",
        authorName: "Ariadne",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "hi from the source",
        editedAt: null,
        createdAt: "2026-04-23T10:00:00Z",
        attachments: [],
      },
    })

    expect(screen.getByText("hi from the source")).toBeInTheDocument()
  })

  it("renders the source message body from local IDB when hydration is absent", async () => {
    await db.events.put({
      id: "evt_cached",
      workspaceId: "ws_1",
      streamId: "stream_src",
      sequence: "1",
      _sequenceNum: 1,
      eventType: "message_created",
      payload: { messageId: "msg_abc", contentMarkdown: "local idb snippet" },
      actorId: "usr_42",
      actorType: "user",
      createdAt: "2026-04-23T10:00:00Z",
      _cachedAt: Date.now(),
    })

    const markdown = "Shared a message from [Ariadne](shared-message:stream_src/msg_abc)"
    renderMarkdown(markdown)

    await waitFor(() => {
      expect(screen.getByText("local idb snippet")).toBeInTheDocument()
    })
  })

  it("links a two-segment (in-stream) pointer back to the source stream permalink", () => {
    renderMarkdown("Shared a message from [Ariadne](shared-message:stream_src/msg_abc)")
    const anchor = document.querySelector('[data-type="shared-message"]')?.closest("a")
    expect(anchor?.getAttribute("href")).toBe("/w/ws_1/s/stream_src?m=msg_abc")
  })

  it("links a conversation-origin pointer back to the conversation panel (deep-linked to the message)", () => {
    renderMarkdown("Shared a message from [Ariadne](shared-message:stream_src/msg_abc/conv_xyz)")
    const anchor = document.querySelector('[data-type="shared-message"]')?.closest("a")
    const href = anchor?.getAttribute("href") ?? ""
    // Opens the board's conversation panel for conv_xyz rather than the stream
    // permalink, still deep-linked to the shared message via `?m=`.
    expect(href).toContain("/w/ws_1/board?")
    expect(href).toContain("conv_xyz")
    expect(href).toContain("m=msg_abc")
    expect(href).not.toContain("/s/stream_src")
  })

  it("leaves plain paragraphs without shared-message anchors untouched", () => {
    renderMarkdown("Just a regular paragraph")
    expect(screen.getByText("Just a regular paragraph").tagName).toBe("P")
    expect(document.querySelector('[data-type="shared-message"]')).toBeNull()
  })

  it("renders the source body as full markdown (bold, links) — not stripped to plain text", () => {
    const markdown = "Shared a message from [Ariadne](shared-message:stream_src/msg_abc)"
    renderMarkdown(markdown, {
      [sharedMessageSlotKey("msg_abc")]: {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_abc",
        streamId: "stream_src",
        authorId: "usr_1",
        authorName: "Ariadne",
        authorType: "user",
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "**Hey** with [a link](https://example.com)",
        editedAt: null,
        createdAt: "2026-04-23T10:00:00Z",
        attachments: [],
      },
    })

    const card = document.querySelector('[data-type="shared-message"]') as HTMLElement
    expect(card).not.toBeNull()
    // Bold renders as <strong>, link renders as <a>; literal markdown syntax must not appear.
    expect(card.querySelector("strong")?.textContent).toBe("Hey")
    expect(card.querySelector("a[href='https://example.com']")?.textContent).toBe("a link")
    expect(card.textContent).not.toContain("**")
  })
})

describe("MarkdownContent — pinned sharedMessage pointers", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  afterEach(async () => {
    await db.events.clear()
  })

  it("renders the pinned span from the pointer's own slot and marks the source as edited since", () => {
    const range = { from: 14, to: 21 }
    renderMarkdown("Shared a message from [Ariadne](shared-message:stream_src/msg_abc?v=2&r=14-21)", {
      // The whole-message slot exists too; the pointer must not read it.
      [sharedMessageSlotKey("msg_abc")]: {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_abc",
        streamId: "stream_src",
        authorId: "usr_1",
        authorName: "Ariadne",
        authorType: "user",
        contentJson: {},
        contentMarkdown: "the whole message as it reads now",
        editedAt: null,
        createdAt: "2026-04-23T10:00:00Z",
        attachments: [],
      },
      [sharedMessageSlotKey("msg_abc", 2, range)]: {
        type: "sharedMessage",
        state: "ok",
        messageId: "msg_abc",
        streamId: "stream_src",
        authorId: "usr_1",
        authorName: "Ariadne",
        authorType: "user",
        contentJson: {},
        contentMarkdown: "**this** is",
        editedAt: null,
        createdAt: "2026-04-23T10:00:00Z",
        attachments: [],
        version: 2,
        currentRevision: 3,
        range,
      },
    })

    expect(screen.getByText("this")).toBeInTheDocument()
    expect(screen.queryByText(/the whole message as it reads now/)).not.toBeInTheDocument()
    expect(screen.getByText(/edited since/i)).toBeInTheDocument()
  })
})
