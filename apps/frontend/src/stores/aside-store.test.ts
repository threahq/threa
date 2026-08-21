import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { renderHook, act } from "@testing-library/react"
import {
  closeAside,
  dropAsideForHost,
  getAsideState,
  openAside,
  rememberedAsideSurface,
  resetAsideStoreCache,
  setAsideSurface,
  useAsideForHost,
} from "./aside-store"

const ACCOUNT_SCOPE = resolve(dirname(fileURLToPath(import.meta.url)), "../auth/account-scope.tsx")

const open = {
  hostKey: "/w/ws_1/s/stream_host",
  hostStreamId: "stream_host",
  asideId: "stream_aside",
  surface: "dock",
} as const

beforeEach(() => resetAsideStoreCache())

describe("aside-store", () => {
  it("should expose the open aside to its host page only", () => {
    const host = renderHook(() => useAsideForHost(open.hostKey))
    const other = renderHook(() => useAsideForHost("/w/ws_1/s/stream_other"))

    act(() => openAside(open))

    expect(host.result.current).toEqual(open)
    expect(other.result.current).toBeNull()
  })

  it("should drop the surface when its host page unmounts and ignore other hosts", () => {
    openAside(open)
    dropAsideForHost("/w/ws_1/s/stream_other")
    expect(getAsideState()).toEqual(open)

    dropAsideForHost(open.hostKey)
    expect(getAsideState()).toBeNull()
  })

  it("should remember the last reading surface, never minimized, for resume", () => {
    openAside(open)
    setAsideSurface("fullscreen")
    setAsideSurface("minimized")
    expect(getAsideState()).toEqual({ ...open, surface: "minimized" })
    expect(rememberedAsideSurface(open.asideId)).toBe("fullscreen")

    closeAside()
    expect(getAsideState()).toBeNull()
    expect(rememberedAsideSurface(open.asideId)).toBe("fullscreen")
    expect(rememberedAsideSurface("stream_never")).toBeNull()
  })

  it("should forget everything on an account switch", () => {
    openAside(open)
    resetAsideStoreCache()
    expect(getAsideState()).toBeNull()
    expect(rememberedAsideSurface(open.asideId)).toBeNull()
  })

  it("registration guard: account-scope flushes the aside store cache", () => {
    const source = readFileSync(ACCOUNT_SCOPE, "utf8")
    const flushBody = source.slice(source.indexOf("function flushModuleStoreCaches"))
    expect(flushBody).toContain("resetAsideStoreCache()")
  })
})
