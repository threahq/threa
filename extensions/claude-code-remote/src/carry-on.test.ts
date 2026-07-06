import { describe, expect, it } from "bun:test"
import { CarryOnController, buildResumePrompt, type CarryOnHost, type CarryOnTiming } from "./carry-on"

const SESSION_LIMIT = "You've hit your session limit · resets 10:20pm (Europe/Stockholm)"
const MONTHLY_LIMIT = "You've hit your org's monthly spend limit · ask your admin to raise it"
const OVERLOADED = "API Error: Overloaded"

// 18:00 UTC = 20:00 in Europe/Stockholm (CEST) — the 10:20pm reset is 2h20m
// out, safely inside the max-hold window whatever the wall clock says. Only
// the quota-reset paths pin `now`; transient paths schedule relative delays,
// so their real timers still fire.
const NOW = Date.UTC(2026, 6, 5, 18, 0, 0)

const FAST: Partial<CarryOnTiming> = {
  keepAliveIntervalMs: 5,
  transientResumeDelayMs: 10,
  minResumeDelayMs: 1,
  resumeJitterMs: 0,
  giveUpRetryDelayMs: 10,
}

interface HostLog {
  notices: Array<{ streamId: string; text: string }>
  closes: Array<{ invocationId: string; text: string }>
  injects: string[]
  keepAlives: number
}

function makeHost(options: { injectOk?: boolean; failCloses?: number } = {}): {
  host: CarryOnHost
  log: HostLog
  inflight: Set<string>
} {
  const log: HostLog = { notices: [], closes: [], injects: [], keepAlives: 0 }
  const inflight = new Set<string>()
  let closesToFail = options.failCloses ?? 0
  const host: CarryOnHost = {
    isInflight: (id) => inflight.has(id),
    keepAlive: () => {
      log.keepAlives += 1
    },
    postNotice: async (streamId, text) => {
      log.notices.push({ streamId, text })
    },
    closeTurn: async (invocationId, text) => {
      if (closesToFail > 0) {
        closesToFail -= 1
        throw new Error("transient close failure")
      }
      log.closes.push({ invocationId, text })
      inflight.delete(invocationId)
    },
    inject: async (text) => {
      log.injects.push(text)
      return options.injectOk ?? true
    },
    log: () => undefined,
    // Pinned clock: delays are computed as (resumeAt - now()) with both sides
    // on this fake now, so relative (transient) timers still fire for real.
    now: () => NOW,
  }
  return { host, log, inflight }
}

function startTurn(controller: CarryOnController, inflight: Set<string>, id = "binv_1", streamId = "stream_1") {
  inflight.add(id)
  controller.onTurnStarted(id, streamId)
  return id
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("CarryOnController", () => {
  it("holds a turn on a session-limit error: notice with the resume time, /carry-on queues, steer absorbs", () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)

    controller.onApiError(id, SESSION_LIMIT)
    expect(controller.holding).toBe(true)
    expect(log.notices).toHaveLength(1)
    expect(log.notices[0]!.text).toContain("session limit")
    expect(log.notices[0]!.text).toContain("/carry-on")

    expect(controller.enqueue("also bump the version").ok).toBe(true)
    expect(controller.enqueue("").message).toContain("1 message(s) queued")
    expect(controller.absorbSteer("and fix the tests")).toContain("queued the steer")
    controller.stop()
  })

  it("ignores API errors for a turn it is not tracking or that is no longer in flight", () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    controller.onApiError("binv_unknown", SESSION_LIMIT)
    expect(controller.holding).toBe(false)

    const id = startTurn(controller, inflight)
    inflight.delete(id)
    controller.onApiError(id, SESSION_LIMIT)
    expect(controller.holding).toBe(false)
    expect(log.notices).toHaveLength(0)
  })

  it("does not hold on non-retryable errors", () => {
    const { host, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, "Prompt is too long")
    expect(controller.holding).toBe(false)
  })

  it("answers /carry-on with guidance when nothing is blocked", () => {
    const { host } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const ack = controller.enqueue("do the thing")
    expect(ack.ok).toBe(false)
    expect(ack.message).toContain("normal message")
  })

  it("resumes a transient failure by injecting the continuation with queued texts", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)

    controller.onApiError(id, OVERLOADED)
    expect(controller.enqueue("remember the changelog").ok).toBe(true)
    await wait(40)

    expect(log.injects).toHaveLength(1)
    expect(log.injects[0]).toContain(id)
    expect(log.injects[0]).toContain("remember the changelog")
    expect(log.closes).toHaveLength(0)
    controller.stop()
  })

  it("keeps the held turn alive while waiting", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, { ...FAST, transientResumeDelayMs: 200, minResumeDelayMs: 200 })
    const id = startTurn(controller, inflight)
    controller.onApiError(id, OVERLOADED)
    await wait(30)
    expect(log.keepAlives).toBeGreaterThan(1)
    controller.stop()
  })

  it("gives up after the resume-attempt cap, carrying queued texts in the close", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, { ...FAST, maxResumeAttempts: 2 })
    const id = startTurn(controller, inflight)

    controller.onApiError(id, OVERLOADED)
    await wait(30) // resume 1 fires, still blocked
    controller.onApiError(id, OVERLOADED)
    await wait(60) // resume 2 fires (backoff doubles), still blocked
    expect(log.injects).toHaveLength(2)

    controller.enqueue("queued while blocked")
    controller.onApiError(id, OVERLOADED) // third failure exceeds the cap
    await wait(10)
    expect(log.closes).toHaveLength(1)
    expect(log.closes[0]!.text).toContain("still blocked after 2 resume attempts")
    expect(log.closes[0]!.text).toContain("queued while blocked")
    expect(controller.holding).toBe(false)
  })

  it("retries the give-up close once when the first attempt fails", async () => {
    const { host, log, inflight } = makeHost({ failCloses: 1 })
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, MONTHLY_LIMIT)
    await wait(40)
    expect(log.closes).toHaveLength(1)
    expect(log.closes[0]!.text).toContain("no reset time")
  })

  it("closes immediately when the quota has no reset time", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, MONTHLY_LIMIT)
    await wait(10)
    expect(log.closes).toHaveLength(1)
    expect(log.closes[0]!.text).toContain("no reset time")
    expect(log.closes[0]!.text).toContain("monthly spend limit")
    expect(controller.holding).toBe(false)
  })

  it("closes the turn when the resume cannot type into the session", async () => {
    const { host, log, inflight } = makeHost({ injectOk: false })
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, OVERLOADED)
    await wait(40)
    expect(log.closes).toHaveLength(1)
    expect(log.closes[0]!.text).toContain("tmux control unavailable")
  })

  it("skips the resume when the turn already closed, surfacing queued texts", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, OVERLOADED)
    controller.enqueue("orphaned instruction")
    inflight.delete(id) // reply landed elsewhere / claim lost
    await wait(40)
    expect(log.injects).toHaveLength(0)
    expect(log.notices.map((n) => n.text).join("\n")).toContain("orphaned instruction")
    expect(controller.holding).toBe(false)
  })

  it("surfaces queued texts when shutdown drops the hold", () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, SESSION_LIMIT)
    controller.enqueue("survive the restart")
    controller.stop()
    expect(controller.holding).toBe(false)
    expect(log.notices.map((n) => n.text).join("\n")).toContain("survive the restart")
  })

  it("drops the hold on /stop and on turn close", () => {
    const { host, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, SESSION_LIMIT)
    expect(controller.holding).toBe(true)
    controller.onInterrupt()
    expect(controller.holding).toBe(false)

    const id2 = startTurn(controller, inflight, "binv_2")
    controller.onApiError(id2, SESSION_LIMIT)
    controller.onTurnClosed(id2)
    expect(controller.holding).toBe(false)
  })
})

describe("buildResumePrompt", () => {
  it("references the invocation and lists queued instructions", () => {
    const prompt = buildResumePrompt("binv_9", ["first", "second"])
    expect(prompt).toContain("binv_9")
    expect(prompt).toContain("1. first")
    expect(prompt).toContain("2. second")
  })

  it("omits the queue section when empty", () => {
    expect(buildResumePrompt("binv_9", [])).not.toContain("queued")
  })
})
