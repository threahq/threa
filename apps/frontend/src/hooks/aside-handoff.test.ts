import { describe, expect, it, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
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
    attrs: { authorId: "persona_1", authorName: "Ariadne", sourceAsideId: "stream_aside" },
    content: [{ type: "paragraph", content: [{ type: "text", text: "Two options." }] }],
  },
]

function handoff() {
  return renderHook(() => useAsideHandoff("ws_1")).result.current
}

beforeEach(async () => {
  __resetShareHandoffStoreForTesting()
  await db.composerTarget.clear()
})

describe("useAsideHandoff", () => {
  it("queues the blocks for the host composer and leaves it composing its own scope", async () => {
    const delivered = await handoff()({
      hostStreamId: "stream_host",
      originScope: "stream:stream_host",
      content: CONTENT,
    })

    expect(delivered).toBe(true)
    expect(peekShareHandoffBatch("stream_host")?.handoffs).toEqual([{ kind: "content", content: CONTENT }])
    expect(await db.composerTarget.get("stream:stream_host")).toBeUndefined()
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
    queueShareHandoff("stream_host", { messageId: "msg_1", streamId: "stream_src" } as never)
    await handoff()({ hostStreamId: "stream_host", originScope: "stream:stream_host", content: CONTENT })

    expect(peekShareHandoffBatch("stream_host")?.handoffs.map((entry) => entry.kind)).toEqual(["pointer", "content"])
  })
})
