import { describe, it, expect } from "vitest"
import { classifyDeepLinkScrollTick } from "./stream-content"

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
