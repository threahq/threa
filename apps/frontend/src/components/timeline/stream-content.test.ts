import { describe, it, expect } from "vitest"
import {
  classifyDeepLinkScrollTick,
  shouldStartHighlightClear,
  computeScrollEdges,
  shouldPrefetchOlderHistory,
} from "./stream-content"

const DEADLINE = 4000

describe("classifyDeepLinkScrollTick", () => {
  it("keeps the loop active while the target is unchanged, unhandled, and within the deadline", () => {
    // This is the regression guard: the old one-shot driver gave up after a
    // single frame. The convergent driver must report "active" every tick
    // until scrollToMessage engages, so an early frame where the scroller is
    // not attached yet does NOT permanently abandon the deep-link.
    for (const elapsedMs of [0, 16, 250, 1000, 3999]) {
      expect(
        classifyDeepLinkScrollTick({
          pendingTarget: "msg_1",
          target: "msg_1",
          userInteractedAt: 0,
          elapsedMs,
          deadlineMs: DEADLINE,
        })
      ).toBe("active")
    }
  })

  it("stops as superseded when the pending target changed (new nav / stream switch / jump failure)", () => {
    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: "msg_2",
        target: "msg_1",
        userInteractedAt: 0,
        elapsedMs: 0,
        deadlineMs: DEADLINE,
      })
    ).toBe("superseded")

    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: null,
        target: "msg_1",
        userInteractedAt: 0,
        elapsedMs: 0,
        deadlineMs: DEADLINE,
      })
    ).toBe("superseded")
  })

  it("stops as user-abort once a genuine gesture has stamped userInteractedAt", () => {
    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: "msg_1",
        target: "msg_1",
        userInteractedAt: 123.45,
        elapsedMs: 50,
        deadlineMs: DEADLINE,
      })
    ).toBe("user-abort")
  })

  it("stops as deadline once the bound elapses without the target ever becoming placeable", () => {
    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: "msg_1",
        target: "msg_1",
        userInteractedAt: 0,
        elapsedMs: DEADLINE,
        deadlineMs: DEADLINE,
      })
    ).toBe("deadline")

    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: "msg_1",
        target: "msg_1",
        userInteractedAt: 0,
        elapsedMs: DEADLINE + 1000,
        deadlineMs: DEADLINE,
      })
    ).toBe("deadline")
  })

  it("prioritises superseded over user-abort and deadline so a stale loop never touches a new target", () => {
    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: "msg_2",
        target: "msg_1",
        userInteractedAt: 999,
        elapsedMs: DEADLINE + 1,
        deadlineMs: DEADLINE,
      })
    ).toBe("superseded")
  })

  it("prioritises user-abort over deadline so a user scroll wins even at the bound", () => {
    expect(
      classifyDeepLinkScrollTick({
        pendingTarget: "msg_1",
        target: "msg_1",
        userInteractedAt: 1,
        elapsedMs: DEADLINE + 1,
        deadlineMs: DEADLINE,
      })
    ).toBe("user-abort")
  })
})

describe("shouldStartHighlightClear", () => {
  it("never starts the countdown without a highlight target", () => {
    for (const highlightMessageId of [null, undefined, ""] as const) {
      expect(
        shouldStartHighlightClear({
          highlightMessageId,
          deepLinkTargetLoaded: true,
          deepLinkGaveUp: true,
        })
      ).toBe(false)
    }
  })

  it("holds the param while a slow (cold push-notification) jump is still loading", () => {
    // This is the regression guard: the old timer fired 3s from mount, so a
    // cold boot whose jump window loads after that window cleared `?m=` before
    // <Virtuoso> mounted, dropping the anchor and dumping the user at the top.
    // The countdown must NOT start until the target is in the loaded window.
    expect(
      shouldStartHighlightClear({
        highlightMessageId: "msg_1",
        deepLinkTargetLoaded: false,
        deepLinkGaveUp: false,
      })
    ).toBe(false)
  })

  it("starts the countdown once the deep-link target is in the loaded window", () => {
    expect(
      shouldStartHighlightClear({
        highlightMessageId: "msg_1",
        deepLinkTargetLoaded: true,
        deepLinkGaveUp: false,
      })
    ).toBe(true)
  })

  it("starts the countdown once the jump conclusively fails so the param can't hang", () => {
    expect(
      shouldStartHighlightClear({
        highlightMessageId: "msg_1",
        deepLinkTargetLoaded: false,
        deepLinkGaveUp: true,
      })
    ).toBe(true)
  })
})

describe("computeScrollEdges", () => {
  // Model a scroller: 5000px of content in an 800px viewport, lead 1500px.
  const SCROLL_HEIGHT = 5000
  const CLIENT_HEIGHT = 800
  const PREFETCH = 1500

  it("stays idle while scrolled into the middle of the loaded window", () => {
    expect(
      computeScrollEdges({
        scrollTop: 2500,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
        prefetchPx: PREFETCH,
      })
    ).toEqual({ reachedStart: false, reachedEnd: false })
  })

  it("leads the older fetch by prefetchPx — fires before the top is reached", () => {
    // Regression guard for the "loading older messages" thrash: the older page
    // must start loading while ~1500px still remain above the viewport, not only
    // when scrollTop hits 0.
    expect(
      computeScrollEdges({
        scrollTop: PREFETCH,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
        prefetchPx: PREFETCH,
      })
    ).toEqual({ reachedStart: true, reachedEnd: false })
  })

  it("does not fire the older fetch while still beyond the lead distance", () => {
    expect(
      computeScrollEdges({
        scrollTop: PREFETCH + 1,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
        prefetchPx: PREFETCH,
      }).reachedStart
    ).toBe(false)
  })

  it("leads the newer fetch by prefetchPx near the bottom of the loaded window", () => {
    // distanceFromBottom = 5000 - scrollTop - 800. At scrollTop 2700 that's
    // 1500 == lead, so the newer fetch fires.
    expect(
      computeScrollEdges({
        scrollTop: 2700,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
        prefetchPx: PREFETCH,
      })
    ).toEqual({ reachedStart: false, reachedEnd: true })
  })
})

describe("shouldPrefetchOlderHistory", () => {
  const base = { followingLiveTail: false, scrollerScrollable: true, hasOlderEvents: true, isFetchingOlder: false }

  it("does not prefetch while parked at the live tail of a scrollable viewport", () => {
    // Regression guard: on load the viewport sits at the tail and the whole
    // loaded window can fit inside the overscan, so reachedStart fires with no
    // user scroll. Prefetching there prepends history above a scrolled anchor
    // and jumps the scroll on load — the cascade this gate exists to prevent.
    expect(shouldPrefetchOlderHistory({ ...base, followingLiveTail: true, scrollerScrollable: true })).toBe(false)
  })

  it("still pages in history at the tail when the window fits the viewport (not scrollable)", () => {
    // The user can't scroll off the tail to unlock pagination, and a non-
    // scrollable prepend is bottom-pinned and jump-free — so it must load.
    expect(shouldPrefetchOlderHistory({ ...base, followingLiveTail: true, scrollerScrollable: false })).toBe(true)
  })

  it("prefetches once scrolled off the tail with older events not already loading", () => {
    expect(shouldPrefetchOlderHistory({ ...base, followingLiveTail: false })).toBe(true)
  })

  it("does not prefetch when there is no older history", () => {
    expect(shouldPrefetchOlderHistory({ ...base, hasOlderEvents: false })).toBe(false)
  })

  it("does not stack a second fetch while one is already in flight", () => {
    expect(shouldPrefetchOlderHistory({ ...base, isFetchingOlder: true })).toBe(false)
  })
})
