import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { renderHook, act } from "@testing-library/react"
import {
  ASIDE_STAGE_DEFAULT_WIDTH,
  asideOpenDraft,
  asidePendingAgentBlocksForTest,
  asideStageWidth,
  closeAside,
  dropAsideForHost,
  getAsideSheetDetent,
  getAsideState,
  openAside,
  clearAsideAgentBlocks,
  queueAsideAgentBlock,
  resetAsideStoreCache,
  setAsideOpenDraft,
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
    expect(asideStageWidth("stream_never")).toBe(ASIDE_STAGE_DEFAULT_WIDTH)
  })

  it("should open a sheet at the peek, whatever the last one was pulled to", () => {
    openAside(open)
    setAsideSheetDetent("full")
    expect(getAsideSheetDetent()).toBe("full")

    closeAside()
    openAside({ ...open, asideId: "stream_other_aside" })
    expect(getAsideSheetDetent()).toBe("peek")
  })

  it("should hold the open draft for the aside, not for whichever surface is showing it", () => {
    // The stage and the phone sheet are different components: anything a
    // surface owned outright would be destroyed crossing between them.
    openAside(open)
    setAsideOpenDraft(open.asideId, "aside:stream_aside:draft_1")

    closeAside()
    openAside(open)
    expect(asideOpenDraft(open.asideId)).toBe("aside:stream_aside:draft_1")
    expect(asideOpenDraft("stream_other")).toBeNull()
  })

  it("should drop a block still queued for an editor when the aside is closed", () => {
    const block = { authorId: "persona_01ARIADNE", authorName: "Ariadne", content: [] }
    openAside(open)
    queueAsideAgentBlock(open.asideId, block)
    expect(asidePendingAgentBlocksForTest(open.asideId)).toEqual([block])

    // Reopening hours later must not append a block queued for a draft the
    // editor never got around to hydrating.
    closeAside()
    openAside(open)
    expect(asidePendingAgentBlocksForTest(open.asideId)).toEqual([])
  })

  it("should drop a queued block once the editor has taken it", () => {
    openAside(open)
    queueAsideAgentBlock(open.asideId, { authorId: "bot_1", authorName: "Deploybot", content: [] })
    clearAsideAgentBlocks(open.asideId)
    expect(asidePendingAgentBlocksForTest(open.asideId)).toEqual([])
  })

  it("should forget everything on an account switch", () => {
    openAside(open)
    setAsideStageWidth(open.asideId, 780)
    setAsideOpenDraft(open.asideId, "aside:stream_aside:draft_1")
    resetAsideStoreCache()
    expect(getAsideState()).toBeNull()
    expect(asideStageWidth(open.asideId)).toBe(ASIDE_STAGE_DEFAULT_WIDTH)
    expect(asideOpenDraft(open.asideId)).toBeNull()
  })

  it("registration guard: account-scope flushes the aside store cache", () => {
    const source = readFileSync(ACCOUNT_SCOPE, "utf8")
    const flushBody = source.slice(source.indexOf("function flushModuleStoreCaches"))
    expect(flushBody).toContain("resetAsideStoreCache()")
  })
})
