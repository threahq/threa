import { describe, it, expect } from "vitest"
import {
  classifyDeepLinkScrollTick,
  shouldStartHighlightClear,
  shouldHoldForDeepLink,
  canActOnDeepLinkNavigation,
  computeScrollEdges,
  shouldPrefetchOlderHistory,
  shouldRunEdgePagination,
  shouldShowOlderSkeletons,
  resolveDateJumpAnchor,
  remapSuppressedWatermark,
  resolveUnreadMarkerOpen,
  resolveAnchorRestore,
  isChromeStripCollapsed,
  buildAgentActivitySummary,
} from "./stream-content"
import { localStartOfDayMs } from "@/lib/dates"
import type { StreamEvent } from "@threa/types"
import type { MessageAgentActivity } from "@/hooks"

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

describe("shouldHoldForDeepLink", () => {
  const base = {
    highlightMessageId: "msg_1" as string | null,
    deepLinkTargetLoaded: false,
    deepLinkGaveUp: false,
    holdExpired: false,
    isLoading: false,
    isConfirmedEmpty: false,
    hasEvents: true,
  }

  it("holds while the target is being fetched into the window", () => {
    expect(shouldHoldForDeepLink(base)).toBe(true)
  })

  it("releases when the hold expires so a slow jump shows the cached window instead of a skeleton", () => {
    // The regression guard for the bound: a cold push-open whose events-around
    // fetch is slow must not sit on a skeleton indefinitely — past
    // DEEP_LINK_HOLD_MAX_MS the cached timeline paints and the jump snaps to
    // the target when it lands.
    expect(shouldHoldForDeepLink({ ...base, holdExpired: true })).toBe(false)
  })

  it("releases when the target lands in the loaded window", () => {
    expect(shouldHoldForDeepLink({ ...base, deepLinkTargetLoaded: true })).toBe(false)
  })

  it("releases when the jump conclusively fails", () => {
    expect(shouldHoldForDeepLink({ ...base, deepLinkGaveUp: true })).toBe(false)
  })

  it("never holds without a highlight target", () => {
    expect(shouldHoldForDeepLink({ ...base, highlightMessageId: null })).toBe(false)
  })

  it("defers to the loading skeleton and empty states while the window itself is unresolved", () => {
    expect(shouldHoldForDeepLink({ ...base, isLoading: true })).toBe(false)
    expect(shouldHoldForDeepLink({ ...base, isConfirmedEmpty: true })).toBe(false)
    expect(shouldHoldForDeepLink({ ...base, hasEvents: false })).toBe(false)
  })
})

describe("canActOnDeepLinkNavigation", () => {
  const base = { highlightMessageId: "msg_1", isLoading: false, isDraft: false, hasEvents: true }

  it("acts once the event window has hydrated", () => {
    expect(canActOnDeepLinkNavigation(base)).toBe(true)
  })

  it("does not act without a highlight target", () => {
    for (const highlightMessageId of [null, undefined, ""] as const) {
      expect(canActOnDeepLinkNavigation({ ...base, highlightMessageId })).toBe(false)
    }
  })

  it("does not act while loading or on a draft stream", () => {
    expect(canActOnDeepLinkNavigation({ ...base, isLoading: true })).toBe(false)
    expect(canActOnDeepLinkNavigation({ ...base, isDraft: true })).toBe(false)
  })

  it("defers while the window is still empty (regression: out-of-window target stuck behind holdForDeepLink)", () => {
    // On a cold deep-link `isLoading` can read false before the IDB live-query
    // resolves. Claiming the navigation then — with no window to scroll within
    // or jump from — stamped the once-per-key guard and blocked the retry once
    // events arrived, leaving an out-of-window target blank forever. The effect
    // must stay re-armed until there is a window to act on.
    expect(canActOnDeepLinkNavigation({ ...base, hasEvents: false })).toBe(false)
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

describe("shouldRunEdgePagination", () => {
  it("blocks edge prefetch while a programmatic jump is still refining", () => {
    expect(shouldRunEdgePagination({ scrollRefineActive: true, isJumpMode: false, userInteractedAt: 0 })).toBe(false)
  })

  it("blocks automatic edge prefetch after landing in a jump window before user scroll", () => {
    expect(shouldRunEdgePagination({ scrollRefineActive: false, isJumpMode: true, userInteractedAt: 0 })).toBe(false)
  })

  it("allows edge prefetch in jump mode after a genuine user scroll", () => {
    expect(shouldRunEdgePagination({ scrollRefineActive: false, isJumpMode: true, userInteractedAt: 123 })).toBe(true)
  })

  it("allows normal edge prefetch outside jump mode", () => {
    expect(shouldRunEdgePagination({ scrollRefineActive: false, isJumpMode: false, userInteractedAt: 0 })).toBe(true)
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

describe("remapSuppressedWatermark", () => {
  const evt = (id: string, eventType: string) => ({ id, eventType }) as unknown as StreamEvent
  // A fresh two-event thread: the member_added seeding event is suppressed
  // from the rendered window; only the reply renders.
  const events = [evt("e_member", "member_added"), evt("e_reply", "message_created")]
  const displayEvents = [evt("e_reply", "message_created")]

  it("remaps a suppressed watermark with no rendered predecessor to null (nothing read)", () => {
    // The ghost-unread-thread bug: the watermark on member_added was
    // unresolvable in the rendered window, so no divider rendered and
    // auto-read never fired — the thread stayed unread forever.
    expect(remapSuppressedWatermark("e_member", events, displayEvents)).toBeNull()
  })

  it("remaps a suppressed watermark to the nearest preceding rendered event", () => {
    const longer = [
      evt("e_msg1", "message_created"),
      evt("e_member2", "member_added"),
      evt("e_msg2", "message_created"),
    ]
    const rendered = [evt("e_msg1", "message_created"), evt("e_msg2", "message_created")]
    expect(remapSuppressedWatermark("e_member2", longer, rendered)).toBe("e_msg1")
  })

  it("passes a rendered watermark through unchanged", () => {
    expect(remapSuppressedWatermark("e_reply", events, displayEvents)).toBe("e_reply")
  })

  it("passes a watermark outside the loaded window through unchanged (suppression semantics apply)", () => {
    expect(remapSuppressedWatermark("e_below_window", events, displayEvents)).toBe("e_below_window")
  })

  it("passes null/undefined (nothing read / still hydrating) through unchanged", () => {
    expect(remapSuppressedWatermark(null, events, displayEvents)).toBeNull()
    expect(remapSuppressedWatermark(undefined, events, displayEvents)).toBeUndefined()
  })
})

describe("resolveUnreadMarkerOpen", () => {
  const base = {
    unreadOpenPosition: "marker" as const,
    alreadyDecided: false,
    isLoading: false,
    isSettling: false,
    readStateResolved: true,
    isJumpMode: false,
    hasDeepLink: false,
    userInteractedAt: 0,
    dividerEventId: "event_5" as string | undefined,
  }

  it("scrolls to the marker once loading, settle, and read state have all resolved", () => {
    expect(resolveUnreadMarkerOpen(base)).toBe("scroll")
  })

  it("waits (without consuming the decision) while the window is loading, the cold-load settle is masking, or the read position is unresolved", () => {
    expect(resolveUnreadMarkerOpen({ ...base, isLoading: true })).toBe("wait")
    expect(resolveUnreadMarkerOpen({ ...base, isSettling: true })).toBe("wait")
    expect(resolveUnreadMarkerOpen({ ...base, readStateResolved: false })).toBe("wait")
  })

  it("waits rather than skips on an unresolved read position even with a divider latched", () => {
    // An unresolvable frontier is not "never read": consuming the once-per-stream
    // decision here is the recurring bug — the stream opens at the tail forever.
    expect(resolveUnreadMarkerOpen({ ...base, readStateResolved: false, dividerEventId: "event_5" })).toBe("wait")
  })

  it("skips in latest mode — the default open-at-bottom behaviour is untouched", () => {
    expect(resolveUnreadMarkerOpen({ ...base, unreadOpenPosition: "latest" })).toBe("skip")
  })

  it("waits while the preference itself has not hydrated (null), so a marker user's cold boot still lands right", () => {
    expect(resolveUnreadMarkerOpen({ ...base, unreadOpenPosition: null })).toBe("wait")
  })

  it("skips when there is nothing unread (no divider latched)", () => {
    expect(resolveUnreadMarkerOpen({ ...base, dividerEventId: undefined })).toBe("skip")
  })

  it("skips when a deep-link or jump owns the scroll position", () => {
    expect(resolveUnreadMarkerOpen({ ...base, hasDeepLink: true })).toBe("skip")
    expect(resolveUnreadMarkerOpen({ ...base, isJumpMode: true })).toBe("skip")
  })

  it("skips once the user has scrolled — a late-resolving divider must not yank a position they chose", () => {
    expect(resolveUnreadMarkerOpen({ ...base, userInteractedAt: 123.4 })).toBe("skip")
  })

  it("decides at most once per stream open — a live message latching a new divider later must not re-scroll", () => {
    expect(resolveUnreadMarkerOpen({ ...base, alreadyDecided: true })).toBe("skip")
  })

  it("consumes the decision as skip (not wait) for a deep-link even while still loading — a deep-linked stream never marker-scrolls", () => {
    expect(resolveUnreadMarkerOpen({ ...base, hasDeepLink: true, isLoading: true })).toBe("skip")
  })
})

describe("isChromeStripCollapsed", () => {
  it("collapses when the strip above the composer drops under the minimum", () => {
    // Mobile keyboard open + tall draft: 360px scroller minus a 230px composer
    // leaves ~2 rows — pills would cover most of it.
    expect(isChromeStripCollapsed(360, 230)).toBe(true)
    // One-line composer with the keyboard open keeps the chrome.
    expect(isChromeStripCollapsed(400, 90)).toBe(false)
    // Desktop never collapses.
    expect(isChromeStripCollapsed(900, 144)).toBe(false)
  })

  it("uses the strip (scroller minus composer), not the raw scroller height", () => {
    expect(isChromeStripCollapsed(800, 700)).toBe(true)
    expect(isChromeStripCollapsed(800, 0)).toBe(false)
  })
})

describe("resolveAnchorRestore", () => {
  const base = {
    alreadyDecided: false,
    isPushNavigation: false,
    isLoading: false,
    isJumpMode: false,
    hasDeepLink: false,
    userInteractedAt: 0,
    hasAnchor: true,
    hasItems: true,
    anchorInWindow: true,
  }

  it("restores as soon as the window is loaded with the anchor in it — it does NOT wait out the cold-load settle, so it can take the settle over behind the mask", () => {
    expect(resolveAnchorRestore(base)).toBe("restore")
  })

  it("skips on PUSH navigation — choosing a stream is a fresh open that lands at the tail and auto-reads", () => {
    expect(resolveAnchorRestore({ ...base, isPushNavigation: true })).toBe("skip")
    // Consumed immediately, never held through load: the nav type won't change.
    expect(resolveAnchorRestore({ ...base, isPushNavigation: true, isLoading: true })).toBe("skip")
  })

  it("waits (without consuming the decision) while the window loads", () => {
    expect(resolveAnchorRestore({ ...base, isLoading: true })).toBe("wait")
  })

  it("waits through the cold-boot grace window — isLoading false but no rows yet must not consume the decision as a stale-anchor skip", () => {
    // The #1873 regression: on reload, computeTimelineLoadState reports
    // isLoading false while IDB is still resolving (no-skeleton-flash grace
    // window), so the decision ran against an empty window, read the anchor as
    // stale, and consumed itself as "skip" — every reload landed at the tail.
    expect(resolveAnchorRestore({ ...base, hasItems: false, anchorInWindow: false })).toBe("wait")
  })

  it("skips with no persisted anchor — the tail open is untouched", () => {
    expect(resolveAnchorRestore({ ...base, hasAnchor: false })).toBe("skip")
    // Consumed as skip even mid-load: nothing later can produce an anchor.
    expect(resolveAnchorRestore({ ...base, hasAnchor: false, isLoading: true })).toBe("skip")
  })

  it("skips when the anchored row is not in the loaded window (stale anchor)", () => {
    expect(resolveAnchorRestore({ ...base, anchorInWindow: false })).toBe("skip")
  })

  it("yields to deep links, jump mode, and user gestures — they own the position", () => {
    expect(resolveAnchorRestore({ ...base, hasDeepLink: true })).toBe("skip")
    expect(resolveAnchorRestore({ ...base, isJumpMode: true })).toBe("skip")
    expect(resolveAnchorRestore({ ...base, userInteractedAt: 42 })).toBe("skip")
  })

  it("decides at most once per stream open", () => {
    expect(resolveAnchorRestore({ ...base, alreadyDecided: true })).toBe("skip")
  })
})

describe("buildAgentActivitySummary", () => {
  const activity = (over: Partial<MessageAgentActivity> & { sessionId: string }): MessageAgentActivity => ({
    personaName: "Ariadne",
    currentStepType: null,
    stepCount: 0,
    messageCount: 0,
    substep: null,
    ...over,
  })
  const startedEvent = (sessionId: string, startedAt: string) =>
    ({
      eventType: "agent_session:started",
      payload: { sessionId, startedAt },
    }) as unknown as StreamEvent

  it("returns an empty array when no session is running", () => {
    expect(buildAgentActivitySummary(new Map(), [])).toEqual([])
    expect(buildAgentActivitySummary(undefined, [])).toEqual([])
  })

  it("returns one entry per running session with its live step count", () => {
    const map = new Map<string, MessageAgentActivity>([
      ["trigger_1", activity({ sessionId: "s1", personaName: "Ariadne", stepCount: 4 })],
    ])
    expect(buildAgentActivitySummary(map, [])).toEqual([{ sessionId: "s1", personaName: "Ariadne", stepCount: 4 }])
  })

  it("dedupes a thread session aliased under both its trigger and parent-message keys", () => {
    // useAgentActivity keys a thread session under two ids; the summary is per session.
    const shared = activity({ sessionId: "s1", stepCount: 2 })
    const map = new Map<string, MessageAgentActivity>([
      ["trigger_1", shared],
      ["parent_msg_1", shared],
    ])
    expect(buildAgentActivitySummary(map, [])).toEqual([{ sessionId: "s1", personaName: "Ariadne", stepCount: 2 }])
  })

  it("orders most recently started first using the started events", () => {
    const map = new Map<string, MessageAgentActivity>([
      ["t_old", activity({ sessionId: "s_old", personaName: "Older" })],
      ["t_new", activity({ sessionId: "s_new", personaName: "Newer" })],
    ])
    const events = [
      startedEvent("s_old", "2026-07-16T10:00:00.000Z"),
      startedEvent("s_new", "2026-07-16T10:05:00.000Z"),
    ]
    expect(buildAgentActivitySummary(map, events).map((e) => e.sessionId)).toEqual(["s_new", "s_old"])
  })

  it("sorts a session with no started event (socket-only channel view) after one that has one", () => {
    const map = new Map<string, MessageAgentActivity>([
      ["t_known", activity({ sessionId: "s_known" })],
      ["t_socket", activity({ sessionId: "s_socket" })],
    ])
    const events = [startedEvent("s_known", "2026-07-16T10:00:00.000Z")]
    expect(buildAgentActivitySummary(map, events).map((e) => e.sessionId)).toEqual(["s_known", "s_socket"])
  })
})
