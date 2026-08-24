import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { renderHook, act } from "@testing-library/react"
import {
  asideStageWidth,
  closeAside,
  dropAsideForHost,
  getAsideSheetDetent,
  getAsideState,
  openAside,
  resetAsideStoreCache,
  setAsideSheetDetent,
  setAsideStageWidth,
  useAsideForHost,
} from "./aside-store"

const ACCOUNT_SCOPE = resolve(dirname(fileURLToPath(import.meta.url)), "../auth/account-scope.tsx")

const open = {
  hostKey: "/w/ws_1/s/stream_host",
  hostStreamId: "stream_host",
  asideId: "stream_aside",
  originScope: "stream:stream_host",
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

  it("should keep the dragged stage width for this aside, and hand every other one the default", () => {
    openAside(open)
    setAsideStageWidth(open.asideId, 780)

    closeAside()
    expect(getAsideState()).toBeNull()
    expect(asideStageWidth(open.asideId)).toBe(780)
    expect(asideStageWidth("stream_never")).toBe(620)
  })

  it("should open a sheet at the peek, whatever the last one was pulled to", () => {
    openAside(open)
    setAsideSheetDetent("full")
    expect(getAsideSheetDetent()).toBe("full")

    closeAside()
    openAside({ ...open, asideId: "stream_other_aside" })
    expect(getAsideSheetDetent()).toBe("peek")
  })

  it("should forget everything on an account switch", () => {
    openAside(open)
    setAsideStageWidth(open.asideId, 780)
    resetAsideStoreCache()
    expect(getAsideState()).toBeNull()
    expect(asideStageWidth(open.asideId)).toBe(620)
  })

  it("registration guard: account-scope flushes the aside store cache", () => {
    const source = readFileSync(ACCOUNT_SCOPE, "utf8")
    const flushBody = source.slice(source.indexOf("function flushModuleStoreCaches"))
    expect(flushBody).toContain("resetAsideStoreCache()")
  })
})
