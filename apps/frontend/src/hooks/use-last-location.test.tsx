import type { ReactNode } from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { useLastLocation, usePersistLastLocation } from "./use-last-location"
import { setLastLocation, getLastLocation, EXACT_RESTORE_WINDOW_MS } from "@/lib/last-location"
import type { CachedStream } from "@/db"

const USER = "usr_1"
const WS = "ws_1"

function stream(id: string, updatedAt = "2026-01-01T00:00:00.000Z"): CachedStream {
  return { id, updatedAt } as unknown as CachedStream
}

function setup({ streams = [] }: { streams?: CachedStream[] }) {
  vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: USER } } as unknown as ReturnType<
    typeof authModule.useAuth
  >)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(streams)
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("useLastLocation — stream arm", () => {
  it("redirects to the stored stream when it still exists", () => {
    setup({ streams: [stream("stream_a")] })
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_a", board: null })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ redirectStreamId: "stream_a", boardHref: null })
  })

  it("falls back to the most-recent stream WITHOUT evicting the record", () => {
    // The cache can't distinguish a deleted stream from a lazily-hydrated
    // thread/conversation id, so an unknown stored id must never destroy the
    // record (it self-heals on the next persisted navigation).
    setup({
      streams: [stream("stream_old", "2026-01-01T00:00:00.000Z"), stream("stream_new", "2026-02-01T00:00:00.000Z")],
    })
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_gone", board: null })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current.redirectStreamId).toBe("stream_new")
    expect(getLastLocation(USER, WS)).toMatchObject({ streamId: "stream_gone" })
  })

  it("signals shouldOpenSidebar when no record and no streams", () => {
    setup({ streams: [] })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ redirectStreamId: null, shouldOpenSidebar: true, boardHref: null })
  })

  it("never falls back into an archived stream, even when it is the most recent", () => {
    // Archiving bumps updated_at, so an unfiltered fallback would pick it.
    const archived = {
      ...stream("stream_archived", "2026-03-01T00:00:00.000Z"),
      archivedAt: "2026-03-01T00:00:00.000Z",
    } as CachedStream
    setup({ streams: [archived, stream("stream_active", "2026-01-01T00:00:00.000Z")] })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current.redirectStreamId).toBe("stream_active")
  })

  it("lands on the fresh-start state when every stream is archived", () => {
    const archived = { ...stream("stream_archived"), archivedAt: "2026-03-01T00:00:00.000Z" } as CachedStream
    setup({ streams: [archived] })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ redirectStreamId: null, shouldOpenSidebar: true })
  })

  it("still honors a stored pointer to a stream archived since the last visit", () => {
    const archived = { ...stream("stream_archived"), archivedAt: "2026-03-01T00:00:00.000Z" } as CachedStream
    setup({ streams: [archived] })
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_archived", board: null })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current.redirectStreamId).toBe("stream_archived")
  })
})

describe("useLastLocation — board arm", () => {
  it("builds the board href from a stored board record, sweeping stale scope", () => {
    setup({ streams: [stream("stream_a")] })
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { search: "?lens=mine&in=stream_a,stream_gone" },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({
      boardHref: "/w/ws_1/board?lens=mine&in=stream_a",
      redirectStreamId: null,
    })
  })
})

describe("useLastLocation — exact arm", () => {
  it("restores a fresh exact path verbatim, panel and all", () => {
    setup({ streams: [stream("stream_a")] })
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { search: "?lens=mine" },
      exact: { path: "/w/ws_1/board?lens=mine&panel=conv:conv_1", at: Date.now() - 60_000 },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({
      exactPath: "/w/ws_1/board?lens=mine&panel=conv:conv_1",
      redirectStreamId: null,
      boardHref: null,
    })
  })

  it("restores a non-stream page the sanitized arms don't cover", () => {
    setup({ streams: [stream("stream_a")] })
    setLastLocation(USER, WS, {
      surface: "stream",
      streamId: "stream_a",
      board: null,
      exact: { path: "/w/ws_1/saved/done", at: Date.now() },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current.exactPath).toBe("/w/ws_1/saved/done")
  })

  it("falls through to the sanitized arms when the exact record is stale", () => {
    setup({ streams: [stream("stream_a")] })
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { search: "?lens=mine" },
      exact: { path: "/w/ws_1/board?lens=mine&panel=conv:conv_1", at: Date.now() - EXACT_RESTORE_WINDOW_MS - 1 },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ exactPath: null, boardHref: "/w/ws_1/board?lens=mine" })
  })

  it("ignores an exact path from another workspace or the bare index", () => {
    setup({ streams: [stream("stream_a")] })
    setLastLocation(USER, WS, {
      surface: "stream",
      streamId: "stream_a",
      board: null,
      exact: { path: "/w/ws_OTHER/s/stream_x", at: Date.now() },
    })
    expect(renderHook(() => useLastLocation(WS)).result.current.exactPath).toBeNull()

    setLastLocation(USER, WS, {
      surface: "stream",
      streamId: "stream_a",
      board: null,
      exact: { path: "/w/ws_1/?m=evt_1", at: Date.now() },
    })
    expect(renderHook(() => useLastLocation(WS)).result.current.exactPath).toBeNull()
  })
})

function routerAt(entry: string) {
  return ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[entry]}>{children}</MemoryRouter>
}

describe("usePersistLastLocation", () => {
  beforeEach(() => {
    vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: USER } } as unknown as ReturnType<
      typeof authModule.useAuth
    >)
  })

  it("retains the prior stream id when writing a board surface", () => {
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_prior", board: null })
    renderHook(() => usePersistLastLocation(WS), {
      wrapper: routerAt("/w/ws_1/board?lens=mine&in=stream_x&panel=stream_z"),
    })
    expect(getLastLocation(USER, WS)).toEqual({
      surface: "board",
      streamId: "stream_prior",
      board: { search: "?lens=mine&in=stream_x" },
      exact: { path: "/w/ws_1/board?lens=mine&in=stream_x&panel=stream_z", at: expect.any(Number) },
    })
  })

  it("retains the prior board record when writing a stream surface", () => {
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: null,
      board: { search: "?lens=mine&in=stream_a" },
    })
    renderHook(() => usePersistLastLocation(WS), { wrapper: routerAt("/w/ws_1/s/stream_new") })
    expect(getLastLocation(USER, WS)).toEqual({
      surface: "stream",
      streamId: "stream_new",
      board: { search: "?lens=mine&in=stream_a" },
      exact: { path: "/w/ws_1/s/stream_new", at: expect.any(Number) },
    })
  })

  it("records the exact URL of a non-stream page without touching the arms", () => {
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_prior", board: { search: "?lens=mine" } })
    renderHook(() => usePersistLastLocation(WS), { wrapper: routerAt("/w/ws_1/activity/mentions") })
    expect(getLastLocation(USER, WS)).toEqual({
      surface: "stream",
      streamId: "stream_prior",
      board: { search: "?lens=mine" },
      exact: { path: "/w/ws_1/activity/mentions", at: expect.any(Number) },
    })
  })

  it("writes nothing on transient redirect routes (index, delegations, memos)", () => {
    for (const path of ["/w/ws_1", "/w/ws_1/delegations/deleg_1", "/w/ws_1/memos/memo_1"]) {
      renderHook(() => usePersistLastLocation(WS), { wrapper: routerAt(path) })
    }
    expect(getLastLocation(USER, WS)).toBeNull()
  })

  it("bumps the exact timestamp when the page is backgrounded", () => {
    renderHook(() => usePersistLastLocation(WS), { wrapper: routerAt("/w/ws_1/s/stream_a") })
    const before = getLastLocation(USER, WS)?.exact
    expect(before).toBeDefined()

    const stale = { ...before!, at: before!.at - 10 * 60_000 }
    setLastLocation(USER, WS, { ...getLastLocation(USER, WS)!, exact: stale })

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    document.dispatchEvent(new Event("visibilitychange"))

    const after = getLastLocation(USER, WS)?.exact
    expect(after).toEqual({ path: "/w/ws_1/s/stream_a", at: expect.any(Number) })
    expect(after!.at).toBeGreaterThan(stale.at)
  })
})
