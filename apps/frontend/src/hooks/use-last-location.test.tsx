import type { ReactNode } from "react"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import * as authModule from "@/auth"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as featureFlagsModule from "@/hooks/use-feature-flags"
import { useLastLocation, usePersistLastLocation } from "./use-last-location"
import { setLastLocation, getLastLocation } from "@/lib/last-location"
import type { CachedStream } from "@/db"

const USER = "usr_1"
const WS = "ws_1"

function stream(id: string, updatedAt = "2026-01-01T00:00:00.000Z"): CachedStream {
  return { id, updatedAt } as unknown as CachedStream
}

function setup({ streams = [], flag = null }: { streams?: CachedStream[]; flag?: "on" | "off" | null }) {
  vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: USER } } as unknown as ReturnType<
    typeof authModule.useAuth
  >)
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(streams)
  vi.spyOn(featureFlagsModule, "useFeatureFlagWhenKnown").mockReturnValue(flag as never)
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
    expect(result.current).toMatchObject({ redirectStreamId: "stream_a", boardHref: null, pendingBoardFlag: false })
  })

  it("falls back to the most-recent stream and evicts a stale record", () => {
    setup({
      streams: [stream("stream_old", "2026-01-01T00:00:00.000Z"), stream("stream_new", "2026-02-01T00:00:00.000Z")],
    })
    setLastLocation(USER, WS, { surface: "stream", streamId: "stream_gone", board: null })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current.redirectStreamId).toBe("stream_new")
    expect(getLastLocation(USER, WS)).toBeNull()
  })

  it("signals shouldOpenSidebar when no record and no streams", () => {
    setup({ streams: [] })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ redirectStreamId: null, shouldOpenSidebar: true, boardHref: null })
  })
})

describe("useLastLocation — board arm", () => {
  it("renders nothing while the flag is unknown", () => {
    setup({ streams: [stream("stream_a")], flag: null })
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { lens: "active", search: "?in=stream_a" },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ pendingBoardFlag: true, boardHref: null, redirectStreamId: null })
  })

  it("builds the board href when the flag is on, sweeping stale scope", () => {
    setup({ streams: [stream("stream_a")], flag: "on" })
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { lens: "active", search: "?in=stream_a,stream_gone" },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({
      boardHref: "/w/ws_1/board/active?in=stream_a",
      pendingBoardFlag: false,
    })
  })

  it("falls through to the retained stream when the flag is off", () => {
    setup({ streams: [stream("stream_a")], flag: "off" })
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: "stream_a",
      board: { lens: "active", search: "?in=stream_a" },
    })
    const { result } = renderHook(() => useLastLocation(WS))
    expect(result.current).toMatchObject({ redirectStreamId: "stream_a", boardHref: null, pendingBoardFlag: false })
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
      wrapper: routerAt("/w/ws_1/board/active?in=stream_x&panel=stream_z"),
    })
    expect(getLastLocation(USER, WS)).toEqual({
      surface: "board",
      streamId: "stream_prior",
      board: { lens: "active", search: "?in=stream_x" },
    })
  })

  it("retains the prior board record when writing a stream surface", () => {
    setLastLocation(USER, WS, {
      surface: "board",
      streamId: null,
      board: { lens: "active", search: "?in=stream_a" },
    })
    renderHook(() => usePersistLastLocation(WS), { wrapper: routerAt("/w/ws_1/s/stream_new") })
    expect(getLastLocation(USER, WS)).toEqual({
      surface: "stream",
      streamId: "stream_new",
      board: { lens: "active", search: "?in=stream_a" },
    })
  })
})
