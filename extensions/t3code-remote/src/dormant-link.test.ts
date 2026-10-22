import { describe, expect, test } from "bun:test"

import { DormantLink } from "./dormant-link"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: { revive?: (rootStreamId: string) => Promise<void> } = {}) {
  const state = { archived: true, revived: [] as string[], watchers: 0, open: 0, logs: [] as string[] }
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
    },
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
})
