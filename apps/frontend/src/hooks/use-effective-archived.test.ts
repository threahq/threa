import { describe, it, expect, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import type { CachedStream } from "@/db"
import { resetWorkspaceStoreCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import { useEffectiveArchived } from "./use-effective-archived"

const WS = "ws_1"
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z"

function row(id: string, overrides: Partial<CachedStream> = {}): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: "thread",
    displayName: id,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_1",
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: null,
    _cachedAt: 0,
    ...overrides,
  } as CachedStream
}

function seed(streams: CachedStream[]) {
  seedWorkspaceCache(WS, {
    workspace: { id: WS, name: "W", slug: "w", createdAt: ARCHIVED_AT, updatedAt: ARCHIVED_AT, _cachedAt: 0 } as never,
    users: [],
    streams,
    memberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

beforeEach(() => {
  resetWorkspaceStoreCache()
  resetWorkspaceTableRegistry()
})

describe("useEffectiveArchived", () => {
  it("seals on the anchor stream's own archivedAt", () => {
    seed([])
    const { result } = renderHook(() =>
      useEffectiveArchived({ workspaceId: WS, stream: { id: "t", archivedAt: ARCHIVED_AT }, fallbackArchived: null })
    )
    expect(result.current).toEqual({ ownArchived: true, ancestorArchived: false, sealedById: null, isArchived: true })
  })

  it("inherits from an archived ancestor at any depth in the stream cache", () => {
    const chan = row("chan", { type: "channel" })
    const a = row("thread_a", { parentStreamId: "chan", rootStreamId: "chan", archivedAt: ARCHIVED_AT })
    const b = row("thread_b", { parentStreamId: "thread_a", rootStreamId: "chan" })
    seed([chan, a, b])
    const { result } = renderHook(() =>
      useEffectiveArchived({
        workspaceId: WS,
        stream: { id: "thread_c", parentStreamId: "thread_b", rootStreamId: "chan", archivedAt: null },
        fallbackArchived: null,
      })
    )
    expect(result.current).toEqual({
      ownArchived: false,
      ancestorArchived: true,
      sealedById: "thread_a",
      isArchived: true,
    })
  })

  it("a fully resolved live chain wins over a stale fallback", () => {
    seed([row("chan", { type: "channel" })])
    const { result } = renderHook(() =>
      useEffectiveArchived({
        workspaceId: WS,
        stream: { id: "t", parentStreamId: "chan", rootStreamId: "chan", archivedAt: null },
        fallbackArchived: { streamId: "chan", archivedAt: ARCHIVED_AT },
      })
    )
    expect(result.current).toEqual({ ownArchived: false, ancestorArchived: false, sealedById: null, isArchived: false })
  })

  it("falls back to the cold-load verdict when a chain link is absent", () => {
    seed([])
    const { result } = renderHook(() =>
      useEffectiveArchived({
        workspaceId: WS,
        stream: { id: "t", parentStreamId: "chan", rootStreamId: "chan", archivedAt: null },
        fallbackArchived: { streamId: "chan", archivedAt: ARCHIVED_AT },
      })
    )
    expect(result.current).toEqual({ ownArchived: false, ancestorArchived: true, sealedById: "chan", isArchived: true })
  })

  it("is unarchived with no own state, an absent chain and no fallback", () => {
    seed([])
    const { result } = renderHook(() =>
      useEffectiveArchived({
        workspaceId: WS,
        stream: { id: "t", parentStreamId: "chan", rootStreamId: "chan", archivedAt: null },
        fallbackArchived: undefined,
      })
    )
    expect(result.current.isArchived).toBe(false)
  })

  it("applies a boolean fallback when the anchor row itself is absent", () => {
    seed([])
    const { result } = renderHook(() =>
      useEffectiveArchived({ workspaceId: WS, stream: undefined, fallbackArchived: true })
    )
    expect(result.current).toEqual({ ownArchived: false, ancestorArchived: true, sealedById: null, isArchived: true })
  })

  it("seals an aside whose host thread sits under an archived root", () => {
    seed([
      row("root", { type: "scratchpad", archivedAt: ARCHIVED_AT }),
      row("host", { parentStreamId: "root", rootStreamId: "root" }),
    ])
    const { result } = renderHook(() =>
      useEffectiveArchived({
        workspaceId: WS,
        stream: { id: "aside", parentStreamId: "host", rootStreamId: null, archivedAt: null },
        fallbackArchived: null,
      })
    )
    expect(result.current).toMatchObject({ ancestorArchived: true, sealedById: "root" })
  })
})
