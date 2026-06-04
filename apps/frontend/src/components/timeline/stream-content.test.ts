import { describe, it, expect } from "vitest"
import {
  classifyDeepLinkScrollTick,
  classifyTailFollowOnAtBottomChange,
  TAIL_FOLLOW_USER_SCROLL_WINDOW_MS,
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

describe("classifyTailFollowOnAtBottomChange", () => {
  const NOW = 100_000

  it("re-pins when a row grows under a stationary reader at the tail (no recent gesture)", () => {
    // The bug: an async embed/image in the last message finishes loading several
    // seconds after the user last touched anything, growing the row past
    // atBottomThreshold. Virtuoso reports atBottom=false; without re-pinning the
    // last message is stranded behind the floating composer.
    expect(
      classifyTailFollowOnAtBottomChange({
        atBottom: false,
        isJumpMode: false,
        nowMs: NOW,
        userInteractedAtMs: NOW - 5_000,
      })
    ).toBe("repin")

    // Never interacted at all (stamp 0) is also content-driven.
    expect(
      classifyTailFollowOnAtBottomChange({ atBottom: false, isJumpMode: false, nowMs: NOW, userInteractedAtMs: 0 })
    ).toBe("repin")
  })

  it("propagates a genuine scroll-away so follow is disabled and the reader isn't yanked back", () => {
    // The threshold crossing fires at the onset of the scroll, right after the
    // gesture, so a fresh stamp marks the user-driven case.
    expect(
      classifyTailFollowOnAtBottomChange({
        atBottom: false,
        isJumpMode: false,
        nowMs: NOW,
        userInteractedAtMs: NOW - 50,
      })
    ).toBe("propagate")
  })

  it("treats the window edge as content-driven (just past the active-scroll window)", () => {
    expect(
      classifyTailFollowOnAtBottomChange({
        atBottom: false,
        isJumpMode: false,
        nowMs: NOW,
        userInteractedAtMs: NOW - TAIL_FOLLOW_USER_SCROLL_WINDOW_MS,
      })
    ).toBe("repin")
    // One ms inside the window is still an active scroll.
    expect(
      classifyTailFollowOnAtBottomChange({
        atBottom: false,
        isJumpMode: false,
        nowMs: NOW,
        userInteractedAtMs: NOW - (TAIL_FOLLOW_USER_SCROLL_WINDOW_MS - 1),
      })
    ).toBe("propagate")
  })

  it("always propagates atBottom=true and never re-pins in jump mode", () => {
    // atBottom=true settles at the tail regardless of timing.
    expect(
      classifyTailFollowOnAtBottomChange({ atBottom: true, isJumpMode: false, nowMs: NOW, userInteractedAtMs: 0 })
    ).toBe("propagate")
    // Deep-link / search reading window: a transient atBottom=false from reflow
    // must not yank the reader to the live tail.
    expect(
      classifyTailFollowOnAtBottomChange({ atBottom: false, isJumpMode: true, nowMs: NOW, userInteractedAtMs: 0 })
    ).toBe("propagate")
  })
})
