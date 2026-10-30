import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import {
  __resetCollapseCacheForTests,
  hydrateCollapseCache,
  getBlockCollapse,
  getRunCollapseMembers,
  setBlockCollapse,
  setLinkPreviewExpand,
  useBlockCollapseStore,
} from "./collapse-cache"
import { db } from "@/db"

const BLOCK_COLLAPSE_LS_KEY = "threa:blockCollapse:v1"
const LINK_PREVIEW_LS_KEY = "threa:linkPreviewExpand:v1"

describe("collapse-cache localStorage mirror", () => {
  beforeEach(async () => {
    __resetCollapseCacheForTests()
    await db.markdownBlockCollapse.clear()
    await db.linkPreviewCollapse.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("writes block-collapse toggles to localStorage synchronously", () => {
    setBlockCollapse("msg_1:code:abc", "msg_1", "code", true)

    const raw = localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as Record<string, boolean>
    expect(parsed["msg_1:code:abc"]).toBe(true)
  })

  it("should restore run identities synchronously on reload alongside legacy booleans", async () => {
    setBlockCollapse("msg_1:run:head", "msg_1", "run", true, ["msg_1", "msg_2", "msg_3"])
    setBlockCollapse("msg_4:code:abc", "msg_4", "code", false)
    vi.resetModules()
    const fresh = await import("./collapse-cache")
    expect({
      collapsed: fresh.getBlockCollapse("msg_1:run:head"),
      members: fresh.getRunCollapseMembers("msg_1:run:head"),
      code: fresh.getBlockCollapse("msg_4:code:abc"),
    }).toEqual({ collapsed: true, members: ["msg_1", "msg_2", "msg_3"], code: false })
    fresh.__resetCollapseCacheForTests()
  })

  it("should discard malformed member metadata without hiding arbitrary rows or throwing", async () => {
    localStorage.setItem(
      BLOCK_COLLAPSE_LS_KEY,
      JSON.stringify({
        "msg_1:run:head": { collapsed: true, memberIds: ["msg_1", 42] },
        "msg_2:run:head": { collapsed: "true", memberIds: ["msg_2", "msg_3"] },
        "msg_4:code:abc": false,
      })
    )
    vi.resetModules()
    const fresh = await import("./collapse-cache")
    expect({
      members: fresh.getRunCollapseMembers("msg_1:run:head"),
      collapsed: fresh.getBlockCollapse("msg_1:run:head"),
      invalid: fresh.getBlockCollapse("msg_2:run:head"),
      legacy: fresh.getBlockCollapse("msg_4:code:abc"),
    }).toEqual({ members: undefined, collapsed: undefined, invalid: undefined, legacy: false })
    fresh.__resetCollapseCacheForTests()
  })

  it("should ignore member identities whose head differs from the persistence key", async () => {
    localStorage.setItem(
      BLOCK_COLLAPSE_LS_KEY,
      JSON.stringify({ "msg_1:run:head": { collapsed: true, memberIds: ["msg_other", "msg_2"] } })
    )
    vi.resetModules()
    const fresh = await import("./collapse-cache")
    expect({
      members: fresh.getRunCollapseMembers("msg_1:run:head"),
      collapsed: fresh.getBlockCollapse("msg_1:run:head"),
    }).toEqual({ members: undefined, collapsed: undefined })
    fresh.__resetCollapseCacheForTests()
  })

  it("should migrate run member metadata from IDB into the synchronous mirror", async () => {
    await db.markdownBlockCollapse.put({
      id: "msg_1:run:head",
      messageId: "msg_1",
      kind: "run",
      collapsed: true,
      memberIds: ["msg_1", "msg_2"],
      updatedAt: Date.now(),
    })
    await hydrateCollapseCache()
    expect({
      collapsed: getBlockCollapse("msg_1:run:head"),
      members: getRunCollapseMembers("msg_1:run:head"),
      stored: JSON.parse(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)!),
    }).toEqual({
      collapsed: true,
      members: ["msg_1", "msg_2"],
      stored: { "msg_1:run:head": { collapsed: true, memberIds: ["msg_1", "msg_2"] } },
    })
  })

  it("should reject invalid IDB members while preserving actual legacy rows", async () => {
    await db.markdownBlockCollapse.bulkPut([
      {
        id: "msg_1:run:head",
        messageId: "msg_1",
        kind: "run",
        collapsed: true,
        memberIds: ["msg_other", "msg_2"],
        updatedAt: 1,
      },
      { id: "msg_3:run:head", messageId: "msg_3", kind: "run", collapsed: true, memberIds: [], updatedAt: 1 },
      { id: "msg_4:run:head", messageId: "msg_4", kind: "run", collapsed: true, updatedAt: 1 },
    ])
    await hydrateCollapseCache()
    expect({
      mismatched: getBlockCollapse("msg_1:run:head"),
      malformed: getBlockCollapse("msg_3:run:head"),
      legacy: getBlockCollapse("msg_4:run:head"),
    }).toEqual({ mismatched: undefined, malformed: undefined, legacy: true })
  })

  it("should preserve a newer reopen and its members while stale IDB hydration is pending", async () => {
    let finishRead!: (rows: Awaited<ReturnType<typeof db.markdownBlockCollapse.toArray>>) => void
    vi.spyOn(db.markdownBlockCollapse, "toArray").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }) as ReturnType<typeof db.markdownBlockCollapse.toArray>
    )
    const hydration = hydrateCollapseCache()
    setBlockCollapse("msg_1:run:head", "msg_1", "run", false, ["msg_1", "msg_2", "msg_3"])
    finishRead([
      {
        id: "msg_1:run:head",
        messageId: "msg_1",
        kind: "run",
        collapsed: true,
        memberIds: ["msg_1", "msg_2"],
        updatedAt: 1,
      },
    ])
    await hydration
    expect({
      collapsed: getBlockCollapse("msg_1:run:head"),
      members: getRunCollapseMembers("msg_1:run:head"),
    }).toEqual({ collapsed: false, members: ["msg_1", "msg_2", "msg_3"] })
  })

  it("writes link-preview toggles to localStorage synchronously", () => {
    setLinkPreviewExpand("msg_1:p_1", "msg_1", "p_1", true)

    const raw = localStorage.getItem(LINK_PREVIEW_LS_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as Record<string, boolean>
    expect(parsed["msg_1:p_1"]).toBe(true)
  })

  it("includes all entries in the localStorage payload, not just the latest", () => {
    setBlockCollapse("msg_1:code:abc", "msg_1", "code", true)
    setBlockCollapse("msg_2:code:def", "msg_2", "code", false)
    setBlockCollapse("msg_3:code:ghi", "msg_3", "code", true)

    const parsed = JSON.parse(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)!) as Record<string, boolean>
    expect(parsed).toEqual({
      "msg_1:code:abc": true,
      "msg_2:code:def": false,
      "msg_3:code:ghi": true,
    })
  })

  it("hydrates IDB rows into localStorage on first migration so subsequent boots are sync", async () => {
    // Existing user: state lives in IDB, localStorage is empty.
    await db.markdownBlockCollapse.put({
      id: "msg_legacy:code:xyz",
      messageId: "msg_legacy",
      kind: "code",
      collapsed: false,
      updatedAt: Date.now(),
    })

    expect(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)).toBeNull()

    await hydrateCollapseCache()

    const parsed = JSON.parse(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)!) as Record<string, boolean>
    expect(parsed["msg_legacy:code:xyz"]).toBe(false)
  })

  it("makes hydrateCollapseCache a no-op when localStorage already populated the cache at module load", async () => {
    // Module load already happened (with empty storage). Simulate "next boot"
    // by writing to localStorage and triggering a fresh module evaluation.
    setBlockCollapse("msg_1:code:abc", "msg_1", "code", true)

    // Reset just the in-memory state and re-import the module; the import-time
    // hydrateFromLocalStorageSync should re-populate the cache and mark it
    // hydrated, so a subsequent hydrateCollapseCache() does no IDB work.
    vi.resetModules()
    const fresh = await import("./collapse-cache")
    // Import @/db after reset to get the same instance that the freshly
    // loaded collapse-cache module holds — top-level `db` is stale.
    const { db: freshDb } = await import("@/db")

    // No IDB rows exist, but the IDB read should not even happen — assert by
    // spying on the table.
    const idbSpy = vi.spyOn(freshDb.markdownBlockCollapse, "toArray")
    await fresh.hydrateCollapseCache()
    expect(idbSpy).not.toHaveBeenCalled()
    idbSpy.mockRestore()

    // The reloaded module should expose the persisted entry through its own
    // hooks — confirms the synchronous read worked.
    const { result } = renderHook(() => fresh.useBlockCollapseStore("msg_1:code:abc"))
    expect(result.current).toBe(true)

    // Tear down the freshly-imported module's state so we don't pollute later tests.
    fresh.__resetCollapseCacheForTests()
  })

  it("__resetCollapseCacheForTests clears both in-memory and localStorage", () => {
    setBlockCollapse("msg_1:code:abc", "msg_1", "code", true)
    setLinkPreviewExpand("msg_1:p_1", "msg_1", "p_1", true)

    expect(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)).not.toBeNull()
    expect(localStorage.getItem(LINK_PREVIEW_LS_KEY)).not.toBeNull()

    __resetCollapseCacheForTests()

    expect(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)).toBeNull()
    expect(localStorage.getItem(LINK_PREVIEW_LS_KEY)).toBeNull()

    const { result } = renderHook(() => useBlockCollapseStore("msg_1:code:abc"))
    expect(result.current).toBeUndefined()
  })

  it("survives a corrupt localStorage payload by falling back to an empty cache", async () => {
    localStorage.setItem(BLOCK_COLLAPSE_LS_KEY, "{not valid json")

    // A fresh module load should not throw — it should silently fall back to
    // an empty in-memory cache and continue operating.
    vi.resetModules()
    const fresh = await import("./collapse-cache")

    const { result } = renderHook(() => fresh.useBlockCollapseStore("any:key"))
    expect(result.current).toBeUndefined()

    // Subsequent writes recover and overwrite the bad payload with valid JSON.
    fresh.setBlockCollapse("msg_1:code:abc", "msg_1", "code", true)
    const parsed = JSON.parse(localStorage.getItem(BLOCK_COLLAPSE_LS_KEY)!) as Record<string, boolean>
    expect(parsed["msg_1:code:abc"]).toBe(true)

    fresh.__resetCollapseCacheForTests()
  })

  it("does not overwrite a recent in-memory toggle with a stale IDB row during migration", async () => {
    // Same race the prior implementation guarded against: a user toggle lands
    // in the in-memory cache (via setBlockCollapse) before hydrateCollapseCache
    // finishes reading IDB. The persisted IDB row holds the previous value;
    // hydration must not clobber the fresh override.
    await db.markdownBlockCollapse.put({
      id: "msg_1:code:abc",
      messageId: "msg_1",
      kind: "code",
      collapsed: true,
      updatedAt: Date.now() - 10_000,
    })

    setBlockCollapse("msg_1:code:abc", "msg_1", "code", false)

    await hydrateCollapseCache()

    const { result } = renderHook(() => useBlockCollapseStore("msg_1:code:abc"))
    expect(result.current).toBe(false)
  })

  it("notifies subscribers when the IDB migration brings in new entries", async () => {
    await db.markdownBlockCollapse.put({
      id: "msg_legacy:code:xyz",
      messageId: "msg_legacy",
      kind: "code",
      collapsed: true,
      updatedAt: Date.now(),
    })

    const { result } = renderHook(() => useBlockCollapseStore("msg_legacy:code:xyz"))
    expect(result.current).toBeUndefined()

    await act(async () => {
      await hydrateCollapseCache()
    })

    expect(result.current).toBe(true)
  })
})
