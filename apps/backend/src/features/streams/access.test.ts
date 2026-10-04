import { describe, expect, it, mock } from "bun:test"
import { listRoomReadableStreamIds, resolveEffectiveAccessStreams } from "./access"
import { StreamRepository, type Stream } from "./repository"

function stream(id: string, workspaceId = "ws_1", rootStreamId: string | null = null): Stream {
  return {
    id,
    workspaceId,
    type: rootStreamId ? "thread" : "channel",
    displayName: null,
    slug: null,
    description: null,
    descriptionJson: null,
    visibility: "private",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId,
    replyCount: 0,
    lastReplyAt: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    archivedAt: null,
  }
}

describe("resolveEffectiveAccessStreams", () => {
  it("enforces workspace, skips dangling roots, and preserves target order", async () => {
    const rootA = stream("stream_a")
    const rootB = stream("stream_b")
    const threadB = stream("thread_b", "ws_1", rootB.id)
    const dangling = stream("thread_missing", "ws_1", "stream_missing")
    const crossWorkspace = stream("stream_other", "ws_2")
    const findByIds = mock(async () => [rootA, rootB, crossWorkspace])
    const original = StreamRepository.findByIds
    StreamRepository.findByIds = findByIds

    try {
      const facts = await resolveEffectiveAccessStreams({} as any, "ws_1", [threadB, dangling, rootA, crossWorkspace])
      expect(facts.map(({ target, root }) => [target.id, root.id])).toEqual([
        [threadB.id, rootB.id],
        [rootA.id, rootA.id],
      ])
      expect(findByIds).toHaveBeenCalledWith({}, "ws_1", [rootB.id, "stream_missing", rootA.id, crossWorkspace.id])
    } finally {
      StreamRepository.findByIds = original
    }
  })

  it("does not query for empty input", async () => {
    const original = StreamRepository.findByIds
    const findByIds = mock(async () => [])
    StreamRepository.findByIds = findByIds
    try {
      expect(await resolveEffectiveAccessStreams({} as any, "ws_1", [])).toEqual([])
      expect(findByIds).not.toHaveBeenCalled()
    } finally {
      StreamRepository.findByIds = original
    }
  })
})

describe("listRoomReadableStreamIds", () => {
  it("returns no ids without querying for empty input", async () => {
    const query = mock(async () => ({ rows: [] }))
    expect(await listRoomReadableStreamIds({ query } as any, "ws_1", "stream_room", [])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })
})
