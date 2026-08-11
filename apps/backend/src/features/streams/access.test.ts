import { describe, expect, it, mock } from "bun:test"
import type { QueryConfig } from "pg"
import { Visibilities } from "@threa/types"
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
    const original = StreamRepository.findByIdsInWorkspace
    StreamRepository.findByIdsInWorkspace = findByIds

    try {
      const facts = await resolveEffectiveAccessStreams({} as any, "ws_1", [threadB, dangling, rootA, crossWorkspace])
      expect(facts.map(({ target, root }) => [target.id, root.id])).toEqual([
        [threadB.id, rootB.id],
        [rootA.id, rootA.id],
      ])
      expect(findByIds).toHaveBeenCalledWith({}, "ws_1", [rootB.id, "stream_missing", rootA.id, crossWorkspace.id])
    } finally {
      StreamRepository.findByIdsInWorkspace = original
    }
  })

  it("does not query for empty input", async () => {
    const original = StreamRepository.findByIdsInWorkspace
    const findByIds = mock(async () => [])
    StreamRepository.findByIdsInWorkspace = findByIds
    try {
      expect(await resolveEffectiveAccessStreams({} as any, "ws_1", [])).toEqual([])
      expect(findByIds).not.toHaveBeenCalled()
    } finally {
      StreamRepository.findByIdsInWorkspace = original
    }
  })
})

describe("listRoomReadableStreamIds", () => {
  it("returns no ids without querying for empty input", async () => {
    const query = mock(async () => ({ rows: [] }))
    expect(await listRoomReadableStreamIds({ query } as any, "ws_1", "stream_room", [])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  it("pins the room-readable SQL: thread→root join, room-or-public predicate, workspace and candidate filters", async () => {
    let captured: QueryConfig | null = null
    const query = mock(async (q: QueryConfig) => {
      captured = q
      return { rows: [{ id: "stream_room" }, { id: "stream_public" }, { id: "thread_public" }] }
    })

    const result = await listRoomReadableStreamIds({ query } as any, "ws_1", "stream_room", [
      "stream_room",
      "stream_public",
      "stream_private",
      "thread_public",
      "thread_private",
      "stream_missing",
    ])

    // Thread → root resolution shares the per-viewer predicate's rule (INV-62).
    expect(captured!.text).toContain("JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id)")
    expect(captured!.text).toContain("s.workspace_id = $1")
    expect(captured!.text).toContain("s.id = ANY($2)")
    expect(captured!.text).toContain("s.id = $3 OR root.visibility = $4")
    expect(captured!.values).toEqual([
      "ws_1",
      ["stream_room", "stream_public", "stream_private", "thread_public", "thread_private", "stream_missing"],
      "stream_room",
      Visibilities.PUBLIC,
    ])
    expect(result).toEqual(new Set(["stream_room", "stream_public", "thread_public"]))
  })
})
