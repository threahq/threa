import { describe, it, expect } from "vitest"
import {
  classifyDeepLinkScrollTick,
  shouldStartHighlightClear,
  computeScrollEdges,
  shouldPrefetchOlderHistory,
  shouldShowOlderSkeletons,
  resolveDateJumpAnchor,
} from "./stream-content"
import { localStartOfDayMs } from "@/lib/dates"

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

describe("shouldShowOlderSkeletons", () => {
  it("shows skeletons while the tracked fetch is in flight and the appear delay has elapsed", () => {
    expect(
      shouldShowOlderSkeletons({
        trackedOldestEventId: "evt_1",
        currentOldestEventId: "evt_1",
        appearDelayElapsed: true,
      })
    ).toBe(true)
  })

  it("does not flash skeletons before the appear delay elapses (fast responses stay skeleton-free)", () => {
    expect(
      shouldShowOlderSkeletons({
        trackedOldestEventId: "evt_1",
        currentOldestEventId: "evt_1",
        appearDelayElapsed: false,
      })
    ).toBe(false)
  })

  it("never shows skeletons when no fetch is tracked — at top of history no fetch ever starts", () => {
    expect(
      shouldShowOlderSkeletons({
        trackedOldestEventId: null,
        currentOldestEventId: "evt_1",
        appearDelayElapsed: true,
      })
    ).toBe(false)
  })

  it("removes skeletons in the same render the prepend lands (oldest id changed)", () => {
    // The load-bearing property (INV-21): removal keys off the rendered oldest
    // id, not isFetchingOlder — the flag flips false a render or two before
    // the IDB live query re-emits with the new page, and dropping skeletons
    // on the flag would leave an intermediate frame N rows shorter.
    expect(
      shouldShowOlderSkeletons({
        trackedOldestEventId: "evt_2",
        currentOldestEventId: "evt_1",
        appearDelayElapsed: true,
      })
    ).toBe(false)
  })

  it("hides skeletons when the window empties mid-fetch (stream switch)", () => {
    expect(
      shouldShowOlderSkeletons({
        trackedOldestEventId: "evt_1",
        currentOldestEventId: null,
        appearDelayElapsed: true,
      })
    ).toBe(false)
  })
})

describe("resolveDateJumpAnchor", () => {
  // Build a message event whose local day is `daysFromTarget` away from a fixed
  // reference day, using mid-day timestamps so timezone never straddles a day
  // boundary. The target day is the reference day itself.
  const REF = new Date(2026, 0, 15, 12, 0, 0) // Jan 15 2026, noon local
  const targetDayMs = localStartOfDayMs(REF)
  const dayMs = 24 * 60 * 60 * 1000
  const msg = (id: string, daysFromTarget: number) => ({
    eventType: "message_created" as const,
    createdAt: new Date(targetDayMs + daysFromTarget * dayMs + 12 * 60 * 60 * 1000).toISOString(),
    payload: { messageId: id },
  })

  it("scrolls directly when a loaded message sits strictly before the target day", () => {
    // Window straddles the day: Jan 14 is before, Jan 15/16 are on-or-after, so
    // the first on-or-after match is the genuine anchor.
    const events = [msg("m_before", -1), msg("m_anchor", 0), msg("m_after", 1)]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: true })).toBe("m_anchor")
  })

  it("fetches when every loaded message is newer than the target and older history exists", () => {
    // The regression: parked at the live tail (all messages on/after the target),
    // a find-first match would return the oldest loaded row. Must fetch instead.
    const events = [msg("m_oldest_loaded", 5), msg("m_mid", 6), msg("m_newest", 7)]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: true })).toBeNull()
  })

  it("scrolls to the first message when the window is the start of the stream (no older history)", () => {
    // No older events to fetch — the first loaded message IS the earliest
    // on-or-after the target, even though nothing precedes it in the window.
    const events = [msg("m_first", 2), msg("m_next", 3)]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: false })).toBe("m_first")
  })

  it("fetches when no loaded message lands on or after the target day", () => {
    // Jumping forward of everything loaded (e.g. scrolled up in old history,
    // then picked today): no in-window match, so fetch a fresh window.
    const events = [msg("m_a", -10), msg("m_b", -9)]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: true })).toBeNull()
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: false })).toBeNull()
  })

  it("ignores non-message events when locating the anchor", () => {
    const events = [
      { eventType: "member_joined" as const, createdAt: new Date(targetDayMs - 5 * dayMs).toISOString(), payload: {} },
      msg("m_before", -1),
      {
        eventType: "member_added" as const,
        createdAt: new Date(targetDayMs + 12 * 60 * 60 * 1000).toISOString(),
        payload: {},
      },
      msg("m_anchor", 0),
    ]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: true })).toBe("m_anchor")
  })

  it("treats companion responses as anchors", () => {
    const events = [
      msg("m_before", -1),
      {
        eventType: "companion_response" as const,
        createdAt: new Date(targetDayMs + 12 * 60 * 60 * 1000).toISOString(),
        payload: { messageId: "m_companion" },
      },
    ]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: true })).toBe("m_companion")
  })

  it("fetches when the in-window match carries no messageId in its payload", () => {
    const events = [
      msg("m_before", -1),
      { eventType: "message_created" as const, createdAt: REF.toISOString(), payload: {} },
    ]
    expect(resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents: true })).toBeNull()
  })
})
