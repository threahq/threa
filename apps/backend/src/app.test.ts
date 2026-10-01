import { describe, expect, it } from "bun:test"
import { connect, type AddressInfo } from "node:net"
import type { Request as ExpressRequest, Response as ExpressResponse } from "express"
import { addLogDestination, attachPostHogLogShipping, createErrorHandler, logger } from "@threahq/backend-common"
import type { AnalyticsEvent, AnalyticsReporter, ExceptionContext } from "@threahq/backend-common"
import { createApp } from "./app"
import { isPushRequestPath } from "@threahq/types"
import { pushReceiptBodyParser, pushReceiptErrors } from "./features/push"
import { createRateLimiters } from "./middleware/rate-limit"

type CapturedLog = Record<string, unknown>

/**
 * The app logs through the process-wide logger, so the assertion has to come
 * off a real destination attached to it. Records are filtered by message, since
 * every other log in the run lands here too.
 */
function captureLogs(): CapturedLog[] {
  const records: CapturedLog[] = []
  addLogDestination({
    level: "info",
    stream: {
      write(line: string) {
        for (const entry of line.split("\n")) {
          if (entry.trim()) records.push(JSON.parse(entry) as CapturedLog)
        }
      },
    },
  })
  return records
}

async function get(
  app: ReturnType<typeof createApp>,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const server = app.listen(0)
  try {
    return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      headers: { authorization: "Bearer secret-token", cookie: "session=abc", ...headers },
    })
  } finally {
    server.close()
  }
}

function expectedRequestLog(statusCode: number, level: number) {
  return {
    level,
    time: expect.any(Number),
    pid: expect.any(Number),
    hostname: expect.any(String),
    req: {
      id: expect.any(String),
      method: "GET",
      url: "/api/v1/workspaces/ws_01WORKSPACE/streams/stream_01ABCDEF?include=members",
      userAgent: expect.any(String),
    },
    res: { statusCode },
    responseTime: expect.any(Number),
    msg: `GET /api/v1/workspaces/:id/streams/:id ${statusCode}`,
  }
}

describe("request logging", () => {
  it("names the route template in the message and keeps the exact URL on the record", async () => {
    const records = captureLogs()
    const app = createApp({ corsAllowedOrigins: [], isProduction: false })
    app.get("/api/v1/workspaces/:workspaceId/streams/:id", (_req, res) => void res.status(403).json({ error: "no" }))

    await get(app, "/api/v1/workspaces/ws_01WORKSPACE/streams/stream_01ABCDEF?include=members")

    // Ids and the query string would make every message unique, so 600
    // identical denials would group into 600 buckets instead of one.
    const denial = records.find((record) => (record.msg as string)?.endsWith("403"))
    expect(denial).toEqual(expectedRequestLog(403, 30))
  })

  it("warns on 400, our own contract breaking", async () => {
    const records = captureLogs()
    const app = createApp({ corsAllowedOrigins: [], isProduction: false })
    app.get("/api/v1/workspaces/:workspaceId/streams/:id", (_req, res) => void res.status(400).json({ error: "no" }))

    await get(app, "/api/v1/workspaces/ws_01WORKSPACE/streams/stream_01ABCDEF?include=members")

    const denial = records.find((record) => (record.msg as string)?.endsWith("400"))
    expect(denial).toEqual(expectedRequestLog(400, 40))
  })
})

describe("disallowed CORS origin", () => {
  it("answers 403 and logs the origin at info, without reporting an exception", async () => {
    const captured: unknown[] = []
    const analyticsReporter: AnalyticsReporter = {
      captureException(error: unknown, _context?: ExceptionContext) {
        captured.push(error)
      },
      captureEvent(_event: AnalyticsEvent) {},
      async shutdown() {},
    }
    const records = captureLogs()
    const app = createApp({ corsAllowedOrigins: ["https://app.example.com"], isProduction: false })
    app.get("/api/v1/workspaces/:workspaceId/streams/:id", (_req, res) => void res.json({ ok: true }))
    app.use(createErrorHandler({ analyticsReporter }))

    const response = await get(app, "/api/v1/workspaces/ws_01WORKSPACE/streams/stream_01ABCDEF?include=members", {
      origin: "https://evil.example.com",
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "CORS origin not allowed", code: "CORS_ORIGIN_NOT_ALLOWED" })
    expect(captured).toEqual([])
    const denial = records.find((record) => (record.msg as string)?.includes("403"))
    expect(denial).toMatchObject({
      level: 30,
      msg: "GET /api/v1/workspaces/:id/streams/:id 403",
      req: { origin: "https://evil.example.com" },
      res: { statusCode: 403 },
    })
  })
})

describe("push diagnostic requests", () => {
  const WORKSPACE = "ws_01SECRETWORKSPACE"
  const TOKEN = "t".repeat(43)
  const SECRETS = {
    requestId: "req-usr_01SECRETUSER",
    userAgent: "Secret-Device-Agent/1.0",
    origin: "https://secret-origin.example",
    cookie: "session=secret-cookie",
  }
  const FAILURE = "statement timeout for usr_01SECRETUSER with hash 5ecret"

  function capturingReporter(): { reporter: AnalyticsReporter; exceptions: Array<[unknown, ExceptionContext?]> } {
    const exceptions: Array<[unknown, ExceptionContext?]> = []
    return {
      exceptions,
      reporter: {
        captureException(error: unknown, context?: ExceptionContext) {
          exceptions.push([error, context])
        },
        captureEvent(_event: AnalyticsEvent) {},
        async shutdown() {},
      },
    }
  }

  /** The receipt route and test poll as routes.ts mounts them, under the real limiters and error policy. */
  function pushApp(globalMax: number, reporter: AnalyticsReporter) {
    const app = createApp({ corsAllowedOrigins: [SECRETS.origin], isProduction: false })
    const limits = createRateLimiters({ globalMax, authMax: 100 })
    app.use(limits.globalBaseline)
    app.post(
      "/api/workspaces/:workspaceId/push/receipts",
      limits.pushReceipt,
      pushReceiptBodyParser,
      (req: ExpressRequest, res: ExpressResponse) => {
        if (req.body.stage === "explode") throw Object.assign(new Error(FAILURE), { code: "57014" })
        res.status(204).end()
      },
      pushReceiptErrors
    )
    app.get("/api/workspaces/:workspaceId/push/test/:testId", () => {
      throw Object.assign(new Error(FAILURE), { code: "57014" })
    })
    app.use(createErrorHandler({ analyticsReporter: reporter, isAnonymous: (req) => isPushRequestPath(req.path) }))
    return app
  }

  /** A raw HTTP/1.1 request, so the request target can be absolute-form. Resolves to the status code. */
  function send(port: number, method: string, target: string, body = ""): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          [
            `${method} ${target} HTTP/1.1`,
            `Host: 127.0.0.1:${port}`,
            "Connection: close",
            "Content-Type: application/json",
            `Content-Length: ${Buffer.byteLength(body)}`,
            `X-Request-Id: ${SECRETS.requestId}`,
            `User-Agent: ${SECRETS.userAgent}`,
            `Origin: ${SECRETS.origin}`,
            `Cookie: ${SECRETS.cookie}`,
            "",
            body,
          ].join("\r\n")
        )
      })
      // Resolve on the status line: Bun does not always close a Connection: close socket after a 404.
      let response = ""
      socket.on("data", (chunk) => {
        response += chunk.toString()
        const status = /^HTTP\/1\.1 (\d{3}) /.exec(response)
        if (!status) return
        socket.destroy()
        resolve(Number(status[1]))
      })
      socket.on("error", reject)
    })
  }

  async function withServer<T>(app: ReturnType<typeof createApp>, run: (port: number) => Promise<T>): Promise<T> {
    const server = app.listen(0)
    try {
      return await run((server.address() as AddressInfo).port)
    } finally {
      server.close()
    }
  }

  const receiptPath = `/api/workspaces/${WORKSPACE}/push/receipts`

  it("should skip the global baseline only for the real receipt POST, which its own per-IP limit bounds", async () => {
    const { reporter } = capturingReporter()
    const lookalikes: Record<string, [string, string]> = {
      "GET on the receipt path": ["GET", receiptPath],
      "suffixed receipt path": ["POST", `${receiptPath}-x`],
      "nested receipt path": ["POST", `${receiptPath}/x`],
      "receipt path under another prefix": ["POST", `/v2${receiptPath}`],
      "test send": ["POST", `/api/workspaces/${WORKSPACE}/push/test`],
      "undecodable workspace segment": ["POST", "/api/workspaces/%zz/push/receipts"],
      "invalid UTF-8 workspace segment": ["POST", "/api/workspaces/%C0%80/push/receipts"],
    }
    const bounded: Record<string, number[]> = {}
    for (const [name, [method, target]] of Object.entries(lookalikes)) {
      bounded[name] = await withServer(pushApp(1, reporter), async (port) => [
        await send(port, method, target),
        await send(port, method, target),
      ])
    }
    const body = JSON.stringify({ token: TOKEN, stage: "received" })
    const receipts = await withServer(pushApp(1, reporter), async (port) => {
      const statuses: number[] = []
      const targets = [receiptPath, receiptPath.toUpperCase(), `http://127.0.0.1:${port}${receiptPath}`]
      for (let i = 0; i < 241; i++) statuses.push(await send(port, "POST", targets[i % targets.length]!, body))
      return { first240: [...new Set(statuses.slice(0, 240))], last: statuses[240] }
    })

    expect({ bounded, receipts }).toEqual({
      bounded: Object.fromEntries(Object.keys(lookalikes).map((name) => [name, [expect.any(Number), 429]])),
      receipts: { first240: [204], last: 429 },
    })
    expect(Object.values(bounded).every(([first]) => first !== 429)).toBe(true)
  }, 30_000)

  it("should keep a mixed-case or absolute-form receipt on the capped parser", async () => {
    const { reporter } = capturingReporter()
    const oversized = JSON.stringify({ token: TOKEN, stage: "received", padding: "x".repeat(4096) })
    const malformed = `{"token":"${TOKEN}",`
    const statuses = await withServer(pushApp(1000, reporter), async (port) => {
      const absolute = `http://127.0.0.1:${port}${receiptPath}`
      const mixed = `/API/Workspaces/${WORKSPACE}/Push/Receipts`
      return {
        mixedOversized: await send(port, "POST", mixed, oversized),
        mixedMalformed: await send(port, "POST", mixed, malformed),
        absoluteOversized: await send(port, "POST", absolute, oversized),
        absoluteMalformed: await send(port, "POST", absolute, malformed),
      }
    })

    expect(statuses).toEqual({
      mixedOversized: 413,
      mixedMalformed: 400,
      absoluteOversized: 413,
      absoluteMalformed: 400,
    })
  })

  it("should log and report push diagnostics anonymously: route template, method, status and error code only", async () => {
    const { reporter, exceptions } = capturingReporter()
    const records = captureLogs()
    const lines: string[] = []
    addLogDestination({ level: "debug", stream: { write: (line: string) => void lines.push(line) } })
    const shipped: string[] = []
    const levelBefore = logger.level
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host: "https://posthog.example.com", logsLevel: "debug" },
      service: "backend",
      region: null,
      environment: "test",
      flushIntervalMs: 50,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        shipped.push(String(init.body))
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
    })!
    const malformed = `{"token":"${TOKEN}",`
    const oversized = JSON.stringify({ token: TOKEN, stage: "received", padding: "x".repeat(4096) })

    const statuses = await withServer(pushApp(1000, reporter), async (port) => {
      const absolute = `http://127.0.0.1:${port}${receiptPath}`
      const result = {
        malformed: await send(port, "POST", receiptPath, malformed),
        oversized: await send(port, "POST", `/API/Workspaces/${WORKSPACE}/Push/Receipts`, oversized),
        failure: await send(port, "POST", absolute, JSON.stringify({ token: TOKEN, stage: "explode" })),
        testProgress: await send(port, "GET", `/api/workspaces/${WORKSPACE}/push/test/push_test_01SECRETTEST`),
        rateLimited: 0,
      }
      // The three receipts above count toward the route's 240 per minute too.
      for (let i = 0; i < 237; i++)
        await send(port, "POST", receiptPath, JSON.stringify({ token: TOKEN, stage: "received" }))
      result.rateLimited = await send(port, "POST", receiptPath, JSON.stringify({ token: TOKEN, stage: "received" }))
      return result
    })
    await shipper.flush()
    await shipper.shutdown()
    logger.level = levelBefore
    const shippedText = shipped.join("\n")

    const pushRecords = records.filter((r) => r.req !== undefined || r.msg === "Unhandled error")
    const shape = (r: Record<string, unknown>) => ({ ...r, time: 0, pid: 0, hostname: "", responseTime: 0 })
    const requestLog = (level: number, method: string, path: string, statusCode: number) => ({
      level,
      time: 0,
      pid: 0,
      hostname: "",
      req: { method, url: path },
      res: { statusCode },
      responseTime: 0,
      msg: `${method} ${path} ${statusCode}`,
    })
    const unhandled = (method: string, path: string) => ({
      level: 50,
      time: 0,
      pid: 0,
      hostname: "",
      responseTime: 0,
      path,
      method,
      errorCode: "57014",
      msg: "Unhandled error",
    })
    const receiptTemplate = "/api/workspaces/:id/push/receipts"
    const testTemplate = "/api/workspaces/:id/push/test/:id"

    expect({ statuses, records: pushRecords.map(shape), exceptions }).toEqual({
      statuses: { malformed: 400, oversized: 413, failure: 500, testProgress: 500, rateLimited: 429 },
      records: [
        requestLog(40, "POST", receiptTemplate, 400),
        requestLog(30, "POST", "/:id/:id/:id/:id/:id", 413),
        unhandled("POST", receiptTemplate),
        requestLog(50, "POST", receiptTemplate, 500),
        unhandled("GET", testTemplate),
        requestLog(50, "GET", testTemplate, 500),
        requestLog(40, "POST", receiptTemplate, 429),
      ],
      exceptions: [
        [
          new Error("Unhandled error (57014)"),
          { properties: { path: receiptTemplate, method: "POST", status_code: 500, error_code: "57014" } },
        ],
        [
          new Error("Unhandled error (57014)"),
          { properties: { path: testTemplate, method: "GET", status_code: 500, error_code: "57014" } },
        ],
      ],
    })
    expect(
      [
        "POST /api/workspaces/:id/push/receipts 429",
        "GET /api/workspaces/:id/push/test/:id 500",
        "Unhandled error",
      ].map((msg) => shippedText.includes(msg))
    ).toEqual([true, true, true])
    const everything = [lines.join("\n"), shippedText, JSON.stringify(exceptions.map(([e, c]) => [String(e), c]))].join(
      "\n"
    )
    const leaked = [...Object.values(SECRETS), TOKEN, WORKSPACE, "usr_01SECRETUSER", "SECRETTEST", "statement timeout"]
    expect(leaked.filter((secret) => everything.includes(secret))).toEqual([])
  }, 30_000)

  it("should log and report every push API route anonymously, and leave a lookalike route identified", async () => {
    const { reporter, exceptions } = capturingReporter()
    const records = captureLogs()
    const endpoint = "https://fcm.googleapis.com/fcm/send/SECRETENDPOINT"
    const failure = `registration failed for ${endpoint}`
    const app = createApp({ corsAllowedOrigins: [SECRETS.origin], isProduction: false })
    const explode = () => {
      throw Object.assign(new Error(failure), { code: "57014" })
    }
    app.get("/api/workspaces/:workspaceId/push/vapid-key", explode)
    app.post("/api/workspaces/:workspaceId/push/subscribe", explode)
    app.post("/api/workspaces/:workspaceId/push/unsubscribe", explode)
    app.post("/api/push/cleanup-endpoint", explode)
    app.post("/api/pushy", explode)
    app.use(createErrorHandler({ analyticsReporter: reporter, isAnonymous: (req) => isPushRequestPath(req.path) }))
    const body = JSON.stringify({ endpoint, keys: { p256dh: "SECRETP256DH", auth: "SECRETAUTH" } })

    const statuses = await withServer(app, async (port) => ({
      vapid: await send(port, "GET", `/api/workspaces/${WORKSPACE}/push/vapid-key`),
      subscribe: await send(port, "POST", `/api/workspaces/${WORKSPACE}/push/subscribe`, body),
      unsubscribe: await send(
        port,
        "POST",
        `http://127.0.0.1:${port}/api/workspaces/${WORKSPACE}/push/unsubscribe`,
        body
      ),
      cleanup: await send(port, "POST", "/API/Push/Cleanup-Endpoint", body),
      lookalike: await send(port, "POST", "/api/pushy", body),
    }))

    const requestLogs = records.filter((r) => r.req !== undefined).map((r) => ({ msg: r.msg, req: r.req }))
    const reported = exceptions.map(([error, context]) => [String(error), context?.properties?.path])
    const anonymous = (method: string, url: string) => ({ msg: `${method} ${url} 500`, req: { method, url } })
    expect({ statuses, requestLogs: requestLogs.slice(0, 4), reported }).toEqual({
      statuses: { vapid: 500, subscribe: 500, unsubscribe: 500, cleanup: 500, lookalike: 500 },
      requestLogs: [
        anonymous("GET", "/api/workspaces/:id/push/vapid-key"),
        anonymous("POST", "/api/workspaces/:id/push/subscribe"),
        anonymous("POST", "/api/workspaces/:id/push/unsubscribe"),
        anonymous("POST", "/:id/:id/:id"),
      ],
      reported: [
        ["Error: Unhandled error (57014)", "/api/workspaces/:id/push/vapid-key"],
        ["Error: Unhandled error (57014)", "/api/workspaces/:id/push/subscribe"],
        ["Error: Unhandled error (57014)", "/api/workspaces/:id/push/unsubscribe"],
        ["Error: Unhandled error (57014)", "/:id/:id/:id"],
        [`Error: ${failure}`, "/api/pushy"],
      ],
    })
    expect(requestLogs[4]).toMatchObject({
      req: { id: SECRETS.requestId, userAgent: SECRETS.userAgent, url: "/api/pushy" },
    })
    const pushText = JSON.stringify([
      records.filter((r) => !JSON.stringify(r).includes("/api/pushy")),
      exceptions.slice(0, 4).map(([e, c]) => [String(e), c]),
    ])
    const leaked = [...Object.values(SECRETS), WORKSPACE, "SECRETENDPOINT", "SECRETP256DH", "SECRETAUTH"]
    expect(leaked.filter((secret) => pushText.includes(secret))).toEqual([])
  }, 30_000)
})
