import { describe, expect, it, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import type { ReactNode } from "react"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import {
  __resetShareHandoffStoreForTesting,
  peekShareHandoffBatch,
  queueShareHandoff,
} from "@/stores/composer-handoff-store"
import { useAsideHandoff } from "./use-aside-handoff"

const CONTENT: JSONContent[] = [
  {
    type: "agentBlock",
    attrs: { authorId: "persona_1", authorName: "Ariadne" },
    content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
  },
]

let pathname = ""
function Probe({ children }: { children: ReactNode }) {
  pathname = useLocation().pathname
  return <>{children}</>
}

/** The hook inside a router parked on the board; `pathname` tracks where it sends the user. */
function handoff() {
  return renderHook(() => useAsideHandoff("ws_1"), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={["/w/ws_1/board"]}>
        <Routes>
          <Route path="*" element={<Probe>{children}</Probe>} />
        </Routes>
      </MemoryRouter>
    ),
  }).result.current
}

/** A mounted host timeline: the scroller `StreamContent` stamps. */
function mountHostScroller(hostStreamId: string): () => void {
  const el = document.createElement("div")
  el.setAttribute("data-stream-scroller", hostStreamId)
  document.body.appendChild(el)
  return () => el.remove()
}

beforeEach(async () => {
  __resetShareHandoffStoreForTesting()
  await db.composerTarget.clear()
})

describe("useAsideHandoff", () => {
  it("queues the blocks for the mounted host composer and stays on the page", async () => {
    const unmount = mountHostScroller("stream_host")
    try {
      const delivered = await handoff()({
        hostStreamId: "stream_host",
        originScope: "stream:stream_host",
        content: CONTENT,
      })

      expect(delivered).toBe(true)
      expect(peekShareHandoffBatch("stream_host")?.handoffs).toEqual([{ kind: "content", content: CONTENT }])
      expect(await db.composerTarget.get("stream:stream_host")).toBeUndefined()
      expect(pathname).toBe("/w/ws_1/board")
    } finally {
      unmount()
    }
  })

  it("takes the user to the host stream when its composer is not on this page (the board)", async () => {
    const delivered = await handoff()({
      hostStreamId: "stream_host",
      originScope: "board:reply:conv_1",
      content: CONTENT,
    })

    expect(delivered).toBe(true)
    expect(peekShareHandoffBatch("stream_host")?.handoffs).toEqual([{ kind: "content", content: CONTENT }])
    await waitFor(() => expect(pathname).toBe("/w/ws_1/s/stream_host"))
  })

  it("points the host composer at the conversation the aside was opened on, then queues", async () => {
    const delivered = await handoff()({
      hostStreamId: "stream_host",
      originScope: "board:reply:conv_1",
      content: CONTENT,
    })

    expect(delivered).toBe(true)
    expect((await db.composerTarget.get("stream:stream_host"))?.scope).toBe("board:reply:conv_1")
    expect(peekShareHandoffBatch("stream_host")?.handoffs).toEqual([{ kind: "content", content: CONTENT }])
  })

  it("refuses an origin the host composer cannot send, rather than stranding the draft", async () => {
    const send = handoff()
    expect(await send({ hostStreamId: "stream_host", originScope: "thread:msg_1", content: CONTENT })).toBe(false)
    expect(await send({ hostStreamId: "stream_host", originScope: "board:subtopic:msg_1", content: CONTENT })).toBe(
      false
    )
    expect(await send({ hostStreamId: "stream_host", originScope: "stream:stream_host", content: [] })).toBe(false)
    expect(peekShareHandoffBatch("stream_host")).toBeNull()
    expect(await db.composerTarget.get("stream:stream_host")).toBeUndefined()
  })

  it("rides the same queue as a share, in order, so one insert path drains both", async () => {
    queueShareHandoff("stream_host", {
      messageId: "msg_1",
      streamId: "stream_src",
      authorName: "Alice",
      authorId: "usr_1",
      actorType: "user",
      version: null,
      range: null,
    })
    await handoff()({ hostStreamId: "stream_host", originScope: "stream:stream_host", content: CONTENT })

    expect(peekShareHandoffBatch("stream_host")?.handoffs.map((entry) => entry.kind)).toEqual(["pointer", "content"])
  })
})
