import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import {
  OLDER_SKELETON_APPEAR_DELAY_MS,
  OLDER_SKELETON_SETTLE_GRACE_MS,
  shouldShowOlderSkeletons,
  useOlderSkeletons,
} from "./use-older-skeletons"

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

describe("useOlderSkeletons", () => {
  type Props = { oldestEventId: string | null; isFetchingOlder: boolean }

  function render(initial: Props) {
    return renderHook((props: Props) => useOlderSkeletons({ ...props, enabled: true }).showSkeletons, {
      initialProps: initial,
    })
  }

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("never shows skeletons when the fetch settles empty before the appear delay", () => {
    // The final older page is empty and answers fast: the tracker stays armed
    // through the settle grace, and the appear delay must not fire in it.
    const hook = render({ oldestEventId: "evt_1", isFetchingOlder: true })
    advance(OLDER_SKELETON_APPEAR_DELAY_MS / 3)
    hook.rerender({ oldestEventId: "evt_1", isFetchingOlder: false })

    const seen: boolean[] = []
    for (let elapsed = 0; elapsed <= OLDER_SKELETON_SETTLE_GRACE_MS; elapsed += 50) {
      seen.push(hook.result.current)
      advance(50)
    }
    expect(seen).not.toContain(true)
  })

  it("shows skeletons for a slow fetch and drops them in the render the prepend lands", () => {
    const hook = render({ oldestEventId: "evt_2", isFetchingOlder: true })
    expect(hook.result.current).toBe(false)
    advance(OLDER_SKELETON_APPEAR_DELAY_MS)
    expect(hook.result.current).toBe(true)

    // isFetchingOlder flips before the IDB live query re-emits: still covered.
    hook.rerender({ oldestEventId: "evt_2", isFetchingOlder: false })
    expect(hook.result.current).toBe(true)

    hook.rerender({ oldestEventId: "evt_1", isFetchingOlder: false })
    expect(hook.result.current).toBe(false)
  })

  it("clears skeletons after the settle grace when a slow fetch returns no page", () => {
    const hook = render({ oldestEventId: "evt_1", isFetchingOlder: true })
    advance(OLDER_SKELETON_APPEAR_DELAY_MS)
    hook.rerender({ oldestEventId: "evt_1", isFetchingOlder: false })
    expect(hook.result.current).toBe(true)

    advance(OLDER_SKELETON_SETTLE_GRACE_MS)
    expect(hook.result.current).toBe(false)
  })
})
