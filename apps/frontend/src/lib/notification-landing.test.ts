import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeCaches, uninstallFakeCaches } from "@/test/fake-caches"
import { createNotificationLanding, type NotificationLandingDeps } from "./notification-landing"
import { stashNotificationTarget } from "./notification-target-storage"

beforeEach(installFakeCaches)
afterEach(() => {
  uninstallFakeCaches()
  vi.restoreAllMocks()
})

const TARGET = "/w/ws_1/s/stream_1?m=msg_1"

function landing(options: { at?: string; historyBeneath?: boolean; navigate?: NotificationLandingDeps["navigate"] }) {
  let current = options.at ?? "/"
  const navigate = options.navigate ?? ((url: string) => void (current = url))
  const calls: Array<{ url: string; replace: boolean }> = []
  const deps: NotificationLandingDeps = {
    navigate: async (url, opts) => {
      calls.push({ url, replace: opts.replace })
      return navigate(url, opts)
    },
    currentUrl: () => current,
    hasHistoryBeneath: () => options.historyBeneath ?? true,
  }
  return { land: createNotificationLanding(deps), calls, at: () => current, arriveAt: (url: string) => (current = url) }
}

describe("notification landing", () => {
  it("navigates to the stashed destination", async () => {
    await stashNotificationTarget({ url: TARGET })
    const { land, calls } = landing({})

    await land()

    expect(calls).toEqual([{ url: TARGET, replace: false }])
  })

  it("replaces on a launch, so back does not land on a start_url that bounces", async () => {
    await stashNotificationTarget({ url: TARGET })
    const { land, calls } = landing({ historyBeneath: false })

    await land()

    expect(calls).toEqual([{ url: TARGET, replace: true }])
  })

  it("navigates once when boot, resume and the worker's message all claim", async () => {
    await stashNotificationTarget({ url: TARGET })
    const { land, calls } = landing({})

    await Promise.all([land(), land(), land({ url: TARGET })])

    expect(calls).toEqual([{ url: TARGET, replace: false }])
  })

  it("uses the worker's message only when the stash is empty", async () => {
    const { land, calls } = landing({})

    await land({ url: "/w/ws_1/s/stream_2", workosUserId: "user_01AAA" })

    expect(calls).toEqual([{ url: "/w/ws_1/s/stream_2", replace: false }])
  })

  it("stays put when the destination is already on screen", async () => {
    await stashNotificationTarget({ url: TARGET })
    const { land, calls } = landing({ at: TARGET })

    await land()

    expect(calls).toEqual([])
  })

  it("refuses a destination that would leave the app", async () => {
    const { land, calls } = landing({})

    await land({ url: "//evil.example/x" })

    expect(calls).toEqual([])
  })

  it("retries once when a boot redirect aborts the navigation", async () => {
    await stashNotificationTarget({ url: TARGET })
    let aborted = false
    const state = landing({
      historyBeneath: false,
      navigate: (url) => {
        if (!aborted) {
          aborted = true
          state.arriveAt("/w/ws_1/s/last_seen")
          return
        }
        state.arriveAt(url)
      },
    })

    await state.land()

    expect(state.calls).toEqual([
      { url: TARGET, replace: true },
      { url: TARGET, replace: true },
    ])
    expect(state.at()).toBe(TARGET)
  })

  it("keeps landing after a failed navigation instead of going quiet for the session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await stashNotificationTarget({ url: TARGET })
    let failNext = true
    const state = landing({
      navigate: (url) => {
        if (failNext) {
          failNext = false
          throw new Error("chunk load failed")
        }
        state.arriveAt(url)
      },
    })

    await state.land()
    await state.land({ url: TARGET })

    expect(state.at()).toBe(TARGET)
  })
})
