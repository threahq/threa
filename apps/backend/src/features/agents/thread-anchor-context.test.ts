import { describe, expect, it, spyOn } from "bun:test"
import { findThreadAnchorContext } from "./thread-anchor-context"
import { MessageRepository, type Message } from "../messaging"
import { StreamEventRepository } from "../streams"

const querier = {} as never

function makeStream(overrides: Record<string, unknown> = {}): any {
  return {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: "thread",
    parentStreamId: "stream_parent",
    parentAnchorId: null,
    parentMessageId: null,
    rootStreamId: "stream_parent",
    ...overrides,
  }
}

describe("findThreadAnchorContext", () => {
  it("returns null when the thread has no anchor", async () => {
    const findThreadRoot = spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(null)
    const eventFindById = spyOn(StreamEventRepository, "findById").mockResolvedValue(null)

    const result = await findThreadAnchorContext(querier, makeStream({ parentAnchorId: null, parentMessageId: null }))

    expect(result).toBeNull()
    expect(findThreadRoot).not.toHaveBeenCalled()
    expect(eventFindById).not.toHaveBeenCalled()
    findThreadRoot.mockRestore()
    eventFindById.mockRestore()
  })

  it("delegates a msg_ anchor to findThreadRoot (soft-delete filter honored)", async () => {
    const rootMessage = { id: "msg_root", contentMarkdown: "the root" } as Message
    const findThreadRoot = spyOn(MessageRepository, "findThreadRoot").mockResolvedValue(rootMessage)

    const result = await findThreadAnchorContext(querier, makeStream({ parentAnchorId: "msg_root" }))

    expect(result).toBe(rootMessage)
    expect(findThreadRoot).toHaveBeenCalled()
    findThreadRoot.mockRestore()
  })

  it("synthesizes a delegation card anchor into terse message-shaped context", async () => {
    const eventFindById = spyOn(StreamEventRepository, "findById").mockResolvedValue({
      id: "event_dlg",
      streamId: "stream_parent",
      sequence: 7n,
      eventType: "delegation:created",
      actorId: "usr_author",
      actorType: "user",
      createdAt: new Date(),
      payload: { delegationId: "dlg_1", title: "Ship the thing", brief: "do X then Y", contextRefs: [] },
    } as never)

    const result = await findThreadAnchorContext(querier, makeStream({ parentAnchorId: "event_dlg" }))

    expect(result).not.toBeNull()
    expect(result!.id).toBe("event_dlg")
    expect(result!.authorId).toBe("usr_author")
    expect(result!.contentMarkdown).toContain("Ship the thing")
    expect(result!.contentMarkdown).toContain("do X then Y")
    eventFindById.mockRestore()
  })

  it("synthesizes a call card anchor tersely", async () => {
    const eventFindById = spyOn(StreamEventRepository, "findById").mockResolvedValue({
      id: "event_call",
      streamId: "stream_parent",
      sequence: 3n,
      eventType: "call_started",
      actorId: "usr_host",
      actorType: "user",
      createdAt: new Date(),
      payload: { callId: "call_1", mode: "audio_only", startedBy: "usr_host", startedAt: new Date().toISOString() },
    } as never)

    const result = await findThreadAnchorContext(querier, makeStream({ parentAnchorId: "event_call" }))

    expect(result!.contentMarkdown).toBe("Call started (audio)")
    eventFindById.mockRestore()
  })

  it("returns null for an event anchor that isn't a serializable card", async () => {
    const eventFindById = spyOn(StreamEventRepository, "findById").mockResolvedValue({
      id: "event_x",
      streamId: "stream_parent",
      sequence: 1n,
      eventType: "member_joined",
      actorId: "usr_a",
      actorType: "user",
      createdAt: new Date(),
      payload: {},
    } as never)

    const result = await findThreadAnchorContext(querier, makeStream({ parentAnchorId: "event_x" }))

    expect(result).toBeNull()
    eventFindById.mockRestore()
  })
})
