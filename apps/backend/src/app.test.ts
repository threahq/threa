import { describe, expect, it } from "bun:test"
import type { AddressInfo } from "node:net"
import { addLogDestination, createErrorHandler } from "@threahq/backend-common"
import type { AnalyticsEvent, AnalyticsReporter, ExceptionContext } from "@threahq/backend-common"
import { createApp } from "./app"

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
