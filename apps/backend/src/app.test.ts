import { describe, expect, it } from "bun:test"
import type { AddressInfo } from "node:net"
import { addLogDestination } from "@threahq/backend-common"
import { createApp } from "./app"

interface CapturedLog {
  msg: string
  req?: { url?: string }
}

/**
 * The app logs through the process-wide logger, so the assertion has to come
 * off a real destination attached to it. Records are filtered by message, since
 * every other log in the run lands here too.
 */
function captureLogs(): CapturedLog[] {
  const records: CapturedLog[] = []
  addLogDestination({
    level: "warn",
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

async function get(app: ReturnType<typeof createApp>, path: string): Promise<void> {
  const server = app.listen(0)
  try {
    await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`)
  } finally {
    server.close()
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
    const denial = records.find((record) => record.msg.endsWith("403"))
    expect(denial?.msg).toBe("GET /api/v1/workspaces/:id/streams/:id 403")
    expect(denial?.req?.url).toBe("/api/v1/workspaces/ws_01WORKSPACE/streams/stream_01ABCDEF?include=members")
  })
})
