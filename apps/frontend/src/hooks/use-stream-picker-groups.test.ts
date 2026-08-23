import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { StreamTypes, type StreamType } from "@threa/types"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { createMockStream } from "@/test/fixtures"
import { isPostableStream } from "@/lib/board-post-target"
import { useStreamPickerGroups } from "./use-stream-picker-groups"

const general = createMockStream({
  id: "stream_c1",
  type: StreamTypes.CHANNEL,
  displayName: "General",
  slug: "general",
})
const random = createMockStream({ id: "stream_c2", type: StreamTypes.CHANNEL, displayName: "Random", slug: "random" })
const dm = createMockStream({ id: "stream_d1", type: StreamTypes.DM, displayName: "Martin" })
const scratch = createMockStream({ id: "stream_s1", type: StreamTypes.SCRATCHPAD, displayName: "My Notes" })
const archived = createMockStream({
  id: "stream_c3",
  type: StreamTypes.CHANNEL,
  displayName: "Old",
  slug: "old",
  archivedAt: "2025-01-01T00:00:00Z",
})
const thread = createMockStream({ id: "stream_t1", type: StreamTypes.THREAD, rootStreamId: "stream_c1" })
const aside = createMockStream({ id: "stream_a1", type: StreamTypes.ASIDE, displayName: "churn number sanity-check" })
const allStreams = [general, random, dm, scratch, archived, thread, aside]

beforeEach(() => {
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(allStreams as never)
  // Member of every stream so the baseline (public-or-member) access filter passes.
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue(
    allStreams.map((s) => ({ streamId: s.id })) as never
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockReturnValue(undefined as never)
})

function groupIds(groups: Map<StreamType, { stream: { id: string } }[]>, type: StreamType): string[] {
  return (groups.get(type) ?? []).map((e) => e.stream.id)
}

describe("useStreamPickerGroups", () => {
  it("groups accessible streams by type and drops archived + thread/system/aside", () => {
    const { result } = renderHook(() => useStreamPickerGroups("workspace_1", { search: "", sortMode: "alphabetical" }))
    expect(groupIds(result.current, StreamTypes.CHANNEL)).toEqual([general.id, random.id])
    expect(groupIds(result.current, StreamTypes.DM)).toEqual([dm.id])
    expect(groupIds(result.current, StreamTypes.SCRATCHPAD)).toEqual([scratch.id])
    expect(result.current.get(StreamTypes.THREAD)).toBeUndefined()
    expect(result.current.get(StreamTypes.ASIDE)).toBeUndefined()
    expect(groupIds(result.current, StreamTypes.CHANNEL)).not.toContain(archived.id)
  })

  it("applies an extra filter (isPostableStream drops scratchpads)", () => {
    const { result } = renderHook(() =>
      useStreamPickerGroups("workspace_1", { search: "", sortMode: "alphabetical", filter: isPostableStream })
    )
    expect(groupIds(result.current, StreamTypes.CHANNEL)).toEqual([general.id, random.id])
    expect(groupIds(result.current, StreamTypes.DM)).toEqual([dm.id])
    expect(result.current.get(StreamTypes.SCRATCHPAD)).toBeUndefined()
  })

  it("narrows to search matches", () => {
    const { result } = renderHook(() => useStreamPickerGroups("workspace_1", { search: "gen", sortMode: "recency" }))
    expect(groupIds(result.current, StreamTypes.CHANNEL)).toEqual([general.id])
    expect(result.current.get(StreamTypes.DM)).toBeUndefined()
  })
})
