import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  clearScopeResolved,
  isResolvedDraftEcho,
  isScopeRecentlyResolved,
  markDraftResolved,
  markScopeResolved,
  resetDraftResolutionGuard,
} from "./draft-resolution-guard"

const scope = "stream:stream_1"
const draftId = "draft_1"

beforeEach(() => {
  resetDraftResolutionGuard()
})

describe("scope guard (local stale-save race)", () => {
  it("marks a scope resolved and reports it within the window", () => {
    expect(isScopeRecentlyResolved(scope)).toBe(false)
    markScopeResolved(scope)
    expect(isScopeRecentlyResolved(scope)).toBe(true)
  })

  it("lifts the guard when the user engages again", () => {
    markScopeResolved(scope)
    clearScopeResolved(scope)
    expect(isScopeRecentlyResolved(scope)).toBe(false)
  })

  it("is scoped per key — resolving one scope does not guard another", () => {
    markScopeResolved(scope)
    expect(isScopeRecentlyResolved("stream:stream_2")).toBe(false)
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

describe("TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("expires the scope and echo guards after the window", () => {
    markScopeResolved(scope)
    markDraftResolved(draftId, 1)
    expect(isScopeRecentlyResolved(scope)).toBe(true)
    expect(isResolvedDraftEcho(draftId, 1)).toBe(true)

    vi.advanceTimersByTime(61_000)

    expect(isScopeRecentlyResolved(scope)).toBe(false)
    expect(isResolvedDraftEcho(draftId, 1)).toBe(false)
  })
})
