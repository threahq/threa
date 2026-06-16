import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  getScopeResolveSeq,
  isResolvedDraftEcho,
  markDraftResolved,
  recordScopeResolved,
  resetDraftResolutionGuard,
} from "./draft-resolution-guard"

const scope = "stream:stream_1"
const draftId = "draft_1"

beforeEach(() => {
  resetDraftResolutionGuard()
})

describe("scope resolve sequence (local stale-save race)", () => {
  it("starts at 0 and increments per resolve", () => {
    expect(getScopeResolveSeq(scope)).toBe(0)
    recordScopeResolved(scope)
    expect(getScopeResolveSeq(scope)).toBe(1)
    recordScopeResolved(scope)
    expect(getScopeResolveSeq(scope)).toBe(2)
  })

  it("is independent per scope", () => {
    recordScopeResolved(scope)
    expect(getScopeResolveSeq("stream:stream_2")).toBe(0)
  })

  it("models the stale-save check: a save started before a resolve sees an advanced seq", () => {
    const observed = getScopeResolveSeq(scope) // captured when the save began
    recordScopeResolved(scope) // a send resolved the scope mid-save
    expect(getScopeResolveSeq(scope) > observed).toBe(true) // → stale, drop the create
  })

  it("models the fresh-save check: a save started after a resolve sees no advance", () => {
    recordScopeResolved(scope)
    const observed = getScopeResolveSeq(scope) // captured after the resolve
    expect(getScopeResolveSeq(scope) > observed).toBe(false) // → not stale, allowed
  })
})

describe("draft echo guard (id + version)", () => {
  it("drops an echo at or below the resolved version", () => {
    markDraftResolved(draftId, 3)
    expect(isResolvedDraftEcho(draftId, 2)).toBe(true)
    expect(isResolvedDraftEcho(draftId, 3)).toBe(true)
  })

  it("does NOT drop a strictly newer version (a real edit from elsewhere)", () => {
    markDraftResolved(draftId, 3)
    expect(isResolvedDraftEcho(draftId, 4)).toBe(false)
  })

  it("ignores ids that were never resolved", () => {
    expect(isResolvedDraftEcho("draft_other", 1)).toBe(false)
  })
})

describe("echo guard TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("expires the echo guard after the window", () => {
    markDraftResolved(draftId, 1)
    expect(isResolvedDraftEcho(draftId, 1)).toBe(true)

    vi.advanceTimersByTime(61_000)

    expect(isResolvedDraftEcho(draftId, 1)).toBe(false)
  })
})
