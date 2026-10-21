import { describe, expect, test } from "bun:test"

import { DormantLink } from "./dormant-link"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const MINUTE = 60_000

function harness(
  options: {
    revive?: (rootStreamId: string) => Promise<void>
    windDown?: () => Promise<void>
    target?: string
  } = {}
) {
  const state = {
    archived: true,
    revived: [] as string[],
    watchers: 0,
    open: 0,
    logs: [] as string[],
    busy: false,
    now: 0,
    events: [] as string[],
  }
  let nudge: (runtimeSessionId?: string) => void = () => {}
  let check: Promise<boolean> | undefined
  const link = new DormantLink({
    runtimeSessionId: "rts_ours",
    watch: (onNudge) => {
      nudge = onNudge
      state.watchers += 1
      state.open += 1
      return { disconnect: () => void (state.open -= 1) }
    },
    isArchived: async () => (check ? check : state.archived),
    revive: async (rootStreamId) => {
      await options.revive?.(rootStreamId)
      state.revived.push(rootStreamId)
      state.events.push("revived")
    },
    isBusy: () => state.busy,
    windDownTarget: () => options.target,
    windDown: async () => {
      await options.windDown?.()
      state.events.push("wound down")
    },
    holdPresence: async () => void state.events.push("held"),
    idleAfterMs: 90 * MINUTE,
    now: () => state.now,
    log: (message) => state.logs.push(message),
  })
  return {
    link,
    state,
    nudge: async (runtimeSessionId?: string) => {
      nudge(runtimeSessionId)
      await tick()
    },
    holdCheck: (pending: Promise<boolean> | undefined) => (check = pending),
  }
}

describe("DormantLink", () => {
  test("links the scratchpad again once it is restored, passing over pushes for other sessions", async () => {
    const { link, state, nudge } = harness()
    link.sleep("stream_root")

    await nudge()
    await nudge("rts_ours")
    state.archived = false
    await nudge("rts_other")
    const beforeRestore = [...state.revived]
    await nudge("rts_ours")
    await nudge("rts_ours")

    expect({ beforeRestore, revived: state.revived, open: state.open }).toEqual({
      beforeRestore: [],
      revived: ["stream_root"],
      open: 0,
    })
  })

  test("a restore that lands while an earlier check is running is not lost", async () => {
    const { link, state, nudge, holdCheck } = harness()
    link.sleep("stream_root")
    const check = deferred<boolean>()
    holdCheck(check.promise)

    await nudge()
    holdCheck(undefined)
    state.archived = false
    await nudge("rts_ours")
    check.resolve(true)
    await tick()

    expect(state.revived).toEqual(["stream_root"])
  })

  test("a failed relink keeps watching and retries on the next message", async () => {
    let attempts = 0
    const { link, state, nudge } = harness({
      revive: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("409 SCRATCHPAD_ARCHIVED")
      },
    })
    link.sleep("stream_root")
    state.archived = false

    await nudge("rts_ours")
    const afterFailure = { revived: [...state.revived], open: state.open }
    await nudge("rts_ours")

    expect({ afterFailure, revived: state.revived, open: state.open, watchers: state.watchers }).toEqual({
      afterFailure: { revived: [], open: 1 },
      revived: ["stream_root"],
      open: 0,
      watchers: 1,
    })
  })

  test("a failed check stays dormant, and a stopped link neither watches nor relinks", async () => {
    const { link, state, nudge, holdCheck } = harness()
    link.sleep("stream_root")
    holdCheck(Promise.reject(new Error("network down")))

    await nudge()
    const afterFailedCheck = { revived: [...state.revived], open: state.open }
    holdCheck(undefined)
    state.archived = false
    await link.stop()
    await nudge("rts_ours")
    link.sleep("stream_root")

    expect({ afterFailedCheck, revived: state.revived, open: state.open, watchers: state.watchers }).toEqual({
      afterFailedCheck: { revived: [], open: 1 },
      revived: [],
      open: 0,
      watchers: 1,
    })
  })

  test("an idle session winds down holding its presence, and only work addressed to it links it again", async () => {
    const { link, state, nudge } = harness({ target: "stream_root" })
    state.archived = false

    state.now = 89 * MINUTE
    await link.tick()
    const beforeWindow = [...state.events]
    state.now = 90 * MINUTE
    await link.tick()
    const beforeSubscribed = [...state.events]
    await nudge()
    state.now = 91 * MINUTE
    await link.tick()
    await nudge()
    await nudge("rts_other")
    const beforeMessage = { events: [...state.events], open: state.open }
    await nudge("rts_ours")
    state.now = 180 * MINUTE
    await link.tick()

    expect({ beforeWindow, beforeSubscribed, beforeMessage, events: state.events, open: state.open }).toEqual({
      beforeWindow: [],
      beforeSubscribed: [],
      beforeMessage: { events: ["wound down", "held", "held"], open: 1 },
      events: ["wound down", "held", "held", "revived"],
      open: 0,
    })
  })

  test("the idle window counts from the last tick a turn was running or a message was delivered", async () => {
    const { link, state, nudge } = harness({ target: "stream_root" })
    state.busy = true
    state.now = 120 * MINUTE
    await link.tick()
    state.busy = false
    state.now = 150 * MINUTE
    link.touch()
    state.now = 239 * MINUTE
    await link.tick()
    const beforeWindow = [...state.events]
    state.now = 240 * MINUTE
    await link.tick()
    await nudge()

    expect({ beforeWindow, events: state.events }).toEqual({ beforeWindow: [], events: ["wound down", "held"] })
  })

  test("a session with nothing to wind down to stays up", async () => {
    const { link, state } = harness()
    state.now = 500 * MINUTE
    await link.tick()

    expect({ events: state.events, watchers: state.watchers }).toEqual({ events: [], watchers: 0 })
  })

  test("a message during the wind-down waits for it before linking again", async () => {
    const shutdown = deferred<void>()
    const { link, state, nudge } = harness({ target: "stream_root", windDown: () => shutdown.promise })
    state.archived = false
    state.now = 90 * MINUTE

    await link.tick()
    await nudge()
    await nudge("rts_ours")
    const whileShuttingDown = [...state.events]
    shutdown.resolve()
    await tick()

    expect({ whileShuttingDown, events: state.events }).toEqual({
      whileShuttingDown: [],
      events: ["wound down", "held", "revived"],
    })
  })

  test("work that arrives before the watcher is subscribed keeps the session up", async () => {
    const { link, state, nudge } = harness({ target: "stream_root" })
    state.now = 90 * MINUTE
    await link.tick()
    link.touch()
    await nudge()
    const afterDelivered = { events: [...state.events], open: state.open }
    state.now = 180 * MINUTE
    await link.tick()
    state.busy = true
    await nudge()

    expect({ afterDelivered, events: state.events, open: state.open, watchers: state.watchers }).toEqual({
      afterDelivered: { events: [], open: 0 },
      events: [],
      open: 0,
      watchers: 2,
    })
  })

  test("a wound-down session that failed to link again retries on the next tick", async () => {
    let attempts = 0
    const { link, state, nudge } = harness({
      target: "stream_root",
      revive: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("socket closed")
      },
    })
    state.archived = false
    state.now = 90 * MINUTE
    await link.tick()
    await nudge()
    await nudge("rts_ours")
    const afterFailure = [...state.events]
    state.now = 91 * MINUTE
    await link.tick()
    await tick()

    expect({ afterFailure, events: state.events, open: state.open }).toEqual({
      afterFailure: ["wound down", "held"],
      events: ["wound down", "held", "revived"],
      open: 0,
    })
  })
})
