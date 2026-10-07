import { describe, expect, test } from "bun:test"
import { RailwayClient } from "./railway"

interface StoredLine {
  timestamp: string
  severity: string
  message: string
  serviceId: string | null
}

const STORED: StoredLine[] = [
  { timestamp: "2026-10-04T17:20:00.000Z", severity: "error", message: "padding-1", serviceId: "svc_b" },
  { timestamp: "2026-10-04T17:24:00.000Z", severity: "error", message: "padding-2", serviceId: "svc_b" },
  { timestamp: "2026-10-04T17:25:30.000Z", severity: "error", message: "target-b", serviceId: "svc_b" },
  { timestamp: "2026-10-04T17:25:10.000Z", severity: "error", message: "target-a", serviceId: "svc_a" },
  { timestamp: "2026-10-04T17:40:00.000Z", severity: "error", message: "at-before-bound", serviceId: "svc_a" },
]

const FAKE_NOW = "2026-10-05T00:00:00.000Z"

/**
 * Emulates the observed Railway behaviour: only `anchorDate` positions the window (default: FAKE_NOW),
 * `afterDate`/`beforeDate` are ignored, and two lines before the anchor are returned as padding.
 */
function fakeRailway(opts: { errors?: string[] } = {}) {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    const respond = (data: unknown) => new Response(JSON.stringify({ data }))
    if (opts.errors && query.includes("environmentLogs")) {
      return new Response(JSON.stringify({ errors: opts.errors.map((message) => ({ message })) }))
    }
    if (query.includes("projectToken")) return respond({ projectToken: { projectId: "p", environmentId: "e" } })
    if (query.includes("services")) {
      return respond({
        project: {
          services: {
            edges: [{ node: { id: "svc_a", name: "backend" } }, { node: { id: "svc_b", name: "worker" } }],
          },
        },
      })
    }
    const argVars = Object.fromEntries([...query.matchAll(/(\w+):\s*\$(\w+)/g)].map((m) => [m[1], m[2]]))
    const anchor = argVars.anchorDate ? String(variables[argVars.anchorDate]) : FAKE_NOW
    const sorted = [...STORED].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const from = sorted.findIndex((l) => l.timestamp >= anchor)
    const rows = from === -1 ? [] : sorted.slice(Math.max(0, from - 2))
    return respond({
      environmentLogs: rows.map((l) => ({
        timestamp: l.timestamp,
        severity: l.severity,
        message: l.message,
        attributes: [{ key: "k", value: "v" }],
        tags: { serviceId: l.serviceId },
      })),
    })
  }) as typeof fetch
  return new RailwayClient("token", fetchImpl)
}

describe("RailwayClient.environmentLogs", () => {
  test("should retrieve historical lines inside [after, before) in order with service names when the window is in the past", async () => {
    const client = fakeRailway()
    const lines = await client.environmentLogs({
      filter: "@level:error",
      after: "2026-10-04T17:24:56.000Z",
      before: "2026-10-04T17:40:00.000Z",
      limit: 100,
    })
    expect(lines).toEqual([
      {
        timestamp: "2026-10-04T17:25:10.000Z",
        severity: "error",
        message: "target-a",
        service: "backend",
        attributes: { k: "v" },
      },
      {
        timestamp: "2026-10-04T17:25:30.000Z",
        severity: "error",
        message: "target-b",
        service: "worker",
        attributes: { k: "v" },
      },
    ])
  })

  test("should return everything from after onward when before is omitted, excluding padding", async () => {
    const client = fakeRailway()
    const lines = await client.environmentLogs({ filter: "", after: "2026-10-04T17:24:56.000Z", limit: 100 })
    expect(lines.map((l) => l.message)).toEqual(["target-a", "target-b", "at-before-bound"])
  })

  test("should surface Railway API errors", async () => {
    const client = fakeRailway({ errors: ["boom"] })
    await expect(client.environmentLogs({ filter: "", after: "2026-10-04T17:24:56.000Z", limit: 10 })).rejects.toThrow(
      "railway: boom"
    )
  })
})
