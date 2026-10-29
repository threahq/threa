import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { StreamTypes, Visibilities, type StreamType } from "@threahq/types"
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
const doc = createMockStream({ id: "stream_doc1", type: StreamTypes.DOC, displayName: "Roadmap" })
const allStreams = [general, random, dm, scratch, archived, thread, aside, doc]

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
  it("groups accessible streams by type and drops archived + thread/system/aside/doc", () => {
    const { result } = renderHook(() => useStreamPickerGroups("workspace_1", { search: "", sortMode: "alphabetical" }))
    expect(groupIds(result.current, StreamTypes.CHANNEL)).toEqual([general.id, random.id])
    expect(groupIds(result.current, StreamTypes.DM)).toEqual([dm.id])
    expect(groupIds(result.current, StreamTypes.SCRATCHPAD)).toEqual([scratch.id])
    expect(result.current.get(StreamTypes.THREAD)).toBeUndefined()
    expect(result.current.get(StreamTypes.ASIDE)).toBeUndefined()
    expect(result.current.get(StreamTypes.DOC)).toBeUndefined()
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

  it("should offer a non-member guest_public channel like a non-member public one when the viewer has not joined", () => {
    const open = [
      createMockStream({
        id: "stream_pub",
        type: StreamTypes.CHANNEL,
        displayName: "Pub",
        visibility: Visibilities.PUBLIC,
      }),
      createMockStream({
        id: "stream_guest",
        type: StreamTypes.CHANNEL,
        displayName: "Guest",
        visibility: Visibilities.GUEST_PUBLIC,
      }),
      createMockStream({
        id: "stream_priv",
        type: StreamTypes.CHANNEL,
        displayName: "Priv",
        visibility: Visibilities.PRIVATE,
      }),
    ]
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(open as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue([] as never)
    const { result } = renderHook(() => useStreamPickerGroups("workspace_1", { search: "", sortMode: "alphabetical" }))
    expect(groupIds(result.current, StreamTypes.CHANNEL)).toEqual(["stream_pub", "stream_guest"])
  })

  it("includes only docs reachable through their accessible, unsealed root when opted in", () => {
    const root = createMockStream({ id: "stream_root", type: StreamTypes.CHANNEL, visibility: Visibilities.PRIVATE })
    const nested = createMockStream({
      id: "stream_nested_doc",
      type: StreamTypes.DOC,
      parentStreamId: root.id,
      rootStreamId: root.id,
      visibility: Visibilities.PRIVATE,
    })
    const nestedChild = createMockStream({
      id: "stream_child_doc",
      type: StreamTypes.DOC,
      parentStreamId: nested.id,
      rootStreamId: root.id,
      visibility: Visibilities.PRIVATE,
    })
    const missingRoot = createMockStream({
      id: "stream_missing_root_doc",
      type: StreamTypes.DOC,
      parentStreamId: "stream_missing_root",
      rootStreamId: null,
      visibility: Visibilities.PUBLIC,
    })
    const archivedRoot = createMockStream({
      id: "stream_archived_root",
      type: StreamTypes.CHANNEL,
      visibility: Visibilities.PRIVATE,
      archivedAt: "2026-10-01T00:00:00Z",
    })
    const archivedDoc = createMockStream({
      id: "stream_archived_doc",
      type: StreamTypes.DOC,
      parentStreamId: archivedRoot.id,
      rootStreamId: archivedRoot.id,
    })
    const rows = [root, nested, nestedChild, missingRoot, archivedRoot, archivedDoc]
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(rows as never)
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockReturnValue([{ streamId: root.id }] as never)

    const ordinary = renderHook(() => useStreamPickerGroups("workspace_1", { search: "", sortMode: "alphabetical" }))
    const optedIn = renderHook(() =>
      useStreamPickerGroups("workspace_1", { search: "", sortMode: "alphabetical", includeDocHosts: true })
    )

    expect(groupIds(ordinary.result.current, StreamTypes.DOC)).toEqual([])
    expect(groupIds(optedIn.result.current, StreamTypes.DOC)).toEqual([nested.id, nestedChild.id])
  })
})
