import { describe, expect, test } from "bun:test"
import { logger } from "../logger"
import {
  PostHogLogShipper,
  type PostHogLogShipperParams,
  attachPostHogLogShipping,
  pinoLevelToSeverity,
  toOtlpAttributes,
} from "./otlp-logs"

interface RecordedCall {
  url: string
  init: RequestInit
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createShipper(overrides: Partial<PostHogLogShipperParams> = {}): {
  shipper: PostHogLogShipper
  calls: RecordedCall[]
  responses: Array<() => Response>
} {
  const calls: RecordedCall[] = []
  const responses: Array<() => Response> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const factory = responses.shift()
    return factory ? factory() : new Response(null, { status: 200 })
  }) as typeof fetch

  const shipper = new PostHogLogShipper({
    config: { projectToken: "phc_test", host: "https://eu.i.posthog.com", logsLevel: "warn" },
    service: "backend",
    region: "eu-north-1",
    environment: "production",
    fetchImpl,
    maxBatch: 100,
    maxQueue: 1000,
    flushIntervalMs: 1_000_000,
    ...overrides,
  })

  return { shipper, calls, responses }
}

describe("pinoLevelToSeverity", () => {
  test("maps every pino level band and clamps in-between levels to the nearest lower band", () => {
    expect(pinoLevelToSeverity(10)).toEqual({ number: 1, text: "TRACE" })
    expect(pinoLevelToSeverity(20)).toEqual({ number: 5, text: "DEBUG" })
    expect(pinoLevelToSeverity(30)).toEqual({ number: 9, text: "INFO" })
    expect(pinoLevelToSeverity(40)).toEqual({ number: 13, text: "WARN" })
    expect(pinoLevelToSeverity(50)).toEqual({ number: 17, text: "ERROR" })
    expect(pinoLevelToSeverity(60)).toEqual({ number: 21, text: "FATAL" })
    expect(pinoLevelToSeverity(35)).toEqual({ number: 9, text: "INFO" })
    expect(pinoLevelToSeverity(5)).toEqual({ number: 1, text: "TRACE" })
  })
})

describe("toOtlpAttributes", () => {
  test("encodes each value type, skips pino's own record fields, and truncates long strings", () => {
    const bigTruncated = `${"x".repeat(2048)}…`
    const record = {
      level: 30,
      time: 1,
      msg: "m",
      pid: 1,
      hostname: "h",
      str: "short",
      int: 42,
      float: 3.14,
      flag: true,
      obj: { a: 1 },
      big: "x".repeat(3000),
    }

    expect(toOtlpAttributes(record)).toEqual([
      { key: "str", value: { stringValue: "short" } },
      { key: "int", value: { intValue: "42" } },
      { key: "float", value: { doubleValue: 3.14 } },
      { key: "flag", value: { boolValue: true } },
      { key: "obj", value: { stringValue: '{"a":1}' } },
      { key: "big", value: { stringValue: bigTruncated } },
    ])
  })
})

describe("PostHogLogShipper", () => {
  test("posts the full OTLP request for one info line", async () => {
    const { shipper, calls } = createShipper()
    shipper.write(
      JSON.stringify({
        level: 30,
        time: 1_700_000_000_000,
        msg: "hello",
        pid: 1,
        hostname: "h",
        workspaceId: "ws_1",
      })
    )
    await shipper.flush()

    const call = calls[0]!
    const headers = Object.fromEntries(new Headers(call.init.headers as HeadersInit))
    expect({ url: call.url, headers, body: JSON.parse(call.init.body as string) }).toEqual({
      url: "https://eu.i.posthog.com/i/v1/logs",
      headers: { authorization: "Bearer phc_test", "content-type": "application/json" },
      body: {
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "threa-backend" } },
                { key: "deployment.environment", value: { stringValue: "production" } },
                { key: "cloud.region", value: { stringValue: "eu-north-1" } },
              ],
            },
            scopeLogs: [
              {
                scope: { name: "pino" },
                logRecords: [
                  {
                    timeUnixNano: "1700000000000000000",
                    severityNumber: 9,
                    severityText: "INFO",
                    body: { stringValue: "hello" },
                    attributes: [{ key: "workspaceId", value: { stringValue: "ws_1" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    await shipper.shutdown()
  })

  test("omits cloud.region from the resource when region is null", async () => {
    const { shipper, calls } = createShipper({ region: null })
    shipper.write(JSON.stringify({ level: 30, time: 1, msg: "a" }))
    await shipper.flush()

    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.resourceLogs[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "threa-backend" } },
      { key: "deployment.environment", value: { stringValue: "production" } },
    ])

    await shipper.shutdown()
  })

  test("flushes automatically once the queue reaches maxBatch", async () => {
    const { shipper, calls } = createShipper({ maxBatch: 2 })

    shipper.write(JSON.stringify({ level: 30, time: 1, msg: "a" }))
    expect(calls.length).toBe(0)
    shipper.write(JSON.stringify({ level: 30, time: 2, msg: "b" }))
    await tick()

    expect(calls.length).toBe(1)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body.resourceLogs[0].scopeLogs[0].logRecords.length).toBe(2)
    expect(shipper.stats().queued).toBe(0)

    await shipper.shutdown()
  })

  test("drops the oldest queued record on overflow and counts it", async () => {
    const { shipper, calls } = createShipper({ maxQueue: 2 })

    shipper.write(JSON.stringify({ level: 30, time: 1, msg: "first" }))
    shipper.write(JSON.stringify({ level: 30, time: 2, msg: "second" }))
    shipper.write(JSON.stringify({ level: 30, time: 3, msg: "third" }))

    expect(shipper.stats()).toEqual({ queued: 2, droppedForOverflow: 1, droppedForParse: 0, droppedBatches: 0 })

    await shipper.flush()
    const body = JSON.parse(calls[0]!.init.body as string)
    const msgs = body.resourceLogs[0].scopeLogs[0].logRecords.map(
      (record: { body: { stringValue: string } }) => record.body.stringValue
    )
    expect(msgs).toEqual(["second", "third"])

    await shipper.shutdown()
  })

  test("counts an unparseable line without throwing", () => {
    const { shipper } = createShipper()

    expect(() => shipper.write("not json")).not.toThrow()
    expect(shipper.stats()).toEqual({ queued: 0, droppedForOverflow: 0, droppedForParse: 1, droppedBatches: 0 })
  })

  test("retries once after a failing response, then drops the batch", async () => {
    const { shipper, calls, responses } = createShipper()
    responses.push(() => new Response(null, { status: 500 }))
    responses.push(() => new Response(null, { status: 500 }))

    shipper.write(JSON.stringify({ level: 50, time: 1, msg: "boom" }))
    await shipper.flush()

    expect(calls.length).toBe(2)
    expect(shipper.stats()).toEqual({ queued: 0, droppedForOverflow: 0, droppedForParse: 0, droppedBatches: 1 })

    await shipper.shutdown()
  })

  test("drains the queue on shutdown", async () => {
    const { shipper, calls } = createShipper()

    shipper.write(JSON.stringify({ level: 30, time: 1, msg: "a" }))
    shipper.write(JSON.stringify({ level: 30, time: 2, msg: "b" }))
    await shipper.shutdown()

    expect(calls.length).toBe(1)
    expect(shipper.stats()).toEqual({ queued: 0, droppedForOverflow: 0, droppedForParse: 0, droppedBatches: 0 })
  })

  test("keeps the flush interval unref'd, and stats() still reads correctly after shutdown", async () => {
    const { shipper } = createShipper({ flushIntervalMs: 5 })
    const timer = (shipper as unknown as { timer: { hasRef?: () => boolean } }).timer

    expect(timer.hasRef?.()).toBe(false)

    await shipper.shutdown()
    expect(shipper.stats()).toEqual({ queued: 0, droppedForOverflow: 0, droppedForParse: 0, droppedBatches: 0 })
  })
})

const host = "https://eu.i.posthog.com"
const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch

describe("attachPostHogLogShipping", () => {
  test("returns null and attaches nothing when logsLevel is null", () => {
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host, logsLevel: null },
      service: "backend",
      region: null,
      environment: "test",
      fetchImpl: okFetch,
    })
    expect(shipper).toBeNull()
  })

  test("queues records at or above its level and drops everything below", async () => {
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host, logsLevel: "warn" },
      service: "backend",
      region: null,
      environment: "test",
      fetchImpl: okFetch,
      flushIntervalMs: 1_000_000,
    })!

    logger.info("posthog-attach-test info line")
    logger.warn("posthog-attach-test warn line")
    logger.error("posthog-attach-test error line")

    expect(shipper.stats().queued).toBe(2)
    await shipper.shutdown()
  })

  test("should receive records below LOG_LEVEL by lowering the root logger level", async () => {
    const previousLevel = logger.level
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host, logsLevel: "debug" },
      service: "backend",
      region: null,
      environment: "test",
      fetchImpl: okFetch,
      flushIntervalMs: 1_000_000,
    })!

    logger.debug("posthog-attach-test debug line")

    expect(shipper.stats().queued).toBe(1)
    await shipper.shutdown()
    logger.level = previousLevel
  })

  test("should stop queueing once shut down, because the destination outlives it", async () => {
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host, logsLevel: "error" },
      service: "backend",
      region: null,
      environment: "test",
      fetchImpl: okFetch,
      flushIntervalMs: 1_000_000,
    })!

    await shipper.shutdown()
    logger.error("posthog-attach-test line after shutdown")

    expect(shipper.stats().queued).toBe(0)
  })
})
