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
  holds: Array<{ invocationId: string; content: string; statusText: string }>
  closes: Array<{ invocationId: string; text: string }>
  injects: string[]
  keepAlives: number
}

function makeHost(options: { injectOk?: boolean; failCloses?: number } = {}): {
  host: CarryOnHost
  log: HostLog
  inflight: Set<string>
} {
  const log: HostLog = { holds: [], closes: [], injects: [], keepAlives: 0 }
  const inflight = new Set<string>()
  let closesToFail = options.failCloses ?? 0
  const host: CarryOnHost = {
    isInflight: (id) => inflight.has(id),
    keepAlive: () => {
      log.keepAlives += 1
    },
    reportHold: async (invocationId, content, statusText) => {
      log.holds.push({ invocationId, content, statusText })
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
  it("holds a turn on a session-limit error: the wait lands on the turn's trace and the session reports held", () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)

    controller.onApiError(id, SESSION_LIMIT)
    expect(controller.holding).toBe(true)
    expect({
      holds: log.holds.length,
      invocationId: log.holds[0]?.invocationId,
      mentionsLimit: log.holds[0]?.content.includes("session limit"),
      mentionsStop: log.holds[0]?.content.includes("/stop"),
      // The reset time renders in the machine's own zone, so only the parts
      // that do not move with it are pinned.
      statusText: log.holds[0]?.statusText.replace(/~\d\d:\d\d/, "~HH:MM"),
    }).toEqual({
      holds: 1,
      invocationId: id,
      mentionsLimit: true,
      mentionsStop: true,
      statusText: "Rate limited — resuming ~HH:MM (in ~2h 20m)",
    })
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
    expect(log.holds).toHaveLength(0)
  })

  it("does not hold on non-retryable errors", () => {
    const { host, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, "Prompt is too long")
    expect(controller.holding).toBe(false)
  })

  it("resumes a transient failure by injecting the continuation", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)

    controller.onApiError(id, OVERLOADED)
    await wait(40)

    expect(log.injects).toHaveLength(1)
    expect(log.injects[0]).toContain(id)
    expect(log.closes).toHaveLength(0)
    controller.stop()
  })

  it("stays awaiting the resume until the continuation has been typed", async () => {
    const { host, inflight } = makeHost()
    let landInject: (ok: boolean) => void = () => undefined
    const controller = new CarryOnController(
      { ...host, inject: () => new Promise<boolean>((resolve) => (landInject = resolve)) },
      FAST
    )
    const id = startTurn(controller, inflight)

    controller.onApiError(id, OVERLOADED)
    await wait(40)
    const typing = controller.awaitingResume
    landInject(true)
    await wait(0)
    const landed = controller.awaitingResume
    controller.stop()

    expect({ typing, landed }).toEqual({ typing: true, landed: false })
  })

  it("leaves a turn stopped during the resume inject alone, even when the inject fails", async () => {
    const { host, log, inflight } = makeHost()
    let landInject: (ok: boolean) => void = () => undefined
    const controller = new CarryOnController(
      { ...host, inject: () => new Promise<boolean>((resolve) => (landInject = resolve)) },
      FAST
    )
    const id = startTurn(controller, inflight)

    controller.onApiError(id, OVERLOADED)
    await wait(40)
    controller.onInterrupt()
    landInject(false)
    await wait(0)

    expect({ closes: log.closes, holding: controller.holding }).toEqual({ closes: [], holding: false })
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

  it("gives up after the resume-attempt cap", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, { ...FAST, maxResumeAttempts: 2 })
    const id = startTurn(controller, inflight)

    controller.onApiError(id, OVERLOADED)
    await wait(30) // resume 1 fires, still blocked
    controller.onApiError(id, OVERLOADED)
    await wait(60) // resume 2 fires (backoff doubles), still blocked
    expect(log.injects).toHaveLength(2)

    controller.onApiError(id, OVERLOADED) // third failure exceeds the cap
    await wait(10)
    expect(log.closes).toHaveLength(1)
    expect(log.closes[0]!.text).toContain("still blocked after 2 resume attempts")
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

  it("skips the resume when the turn already closed", async () => {
    const { host, log, inflight } = makeHost()
    const controller = new CarryOnController(host, FAST)
    const id = startTurn(controller, inflight)
    controller.onApiError(id, OVERLOADED)
    inflight.delete(id) // reply landed elsewhere / claim lost
    await wait(40)
    expect(log.injects).toHaveLength(0)
    expect(controller.holding).toBe(false)
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
  it("references the invocation", () => {
    expect(buildResumePrompt("binv_9")).toContain("binv_9")
  })
})
