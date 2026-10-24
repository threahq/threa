import { describe, expect, test } from "bun:test"
import { type ExceptionGroup, hogqlUtc, PostHogClient } from "../posthog"
import type { RailwayLogLine } from "../railway"
import { makeWindow } from "../types"
import { summarizePostHog } from "./posthog"

const window = makeWindow(new Date("2026-10-20T10:00:00.000Z"), new Date("2026-10-20T12:00:00.000Z"), 0, "since")

const exception = (over: Partial<ExceptionGroup> = {}): ExceptionGroup => ({
  issueId: "issue-1",
  lib: "posthog-node",
  type: "TypeError",
  value: "x is undefined",
  since: 0,
  prior: 0,
  lastAt: "2026-10-20T11:00:00.000Z",
  ...over,
})

const logLine = (timestamp: string, message: string): RailwayLogLine => ({
  timestamp,
  severity: "error",
  message,
  service: "backend",
  attributes: {},
})

const base = {
  errSince: [],
  errPrior: [],
  warnSince: [],
  warnPrior: [],
  exceptions: [],
  exceptionsTruncated: false,
  retainedFrom: null,
}

const fakeClient = (respond: (query: string) => Response) => {
  const queries: string[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body)) as { query: { query: string } }
    queries.push(query.query)
    return respond(query.query)
  }) as unknown as typeof fetch
  return { client: new PostHogClient("key", "1", fetchImpl), queries }
}

describe("hogqlUtc", () => {
  test("should pin a UTC datetime literal when given an ISO string with an offset", () => {
    expect(hogqlUtc("2026-10-20T20:49:23.934+02:00")).toBe("toDateTime('2026-10-20 18:49:23', 'UTC')")
  })
})

describe("PostHogClient", () => {
  test("should return logs oldest-first with service names unprefixed when PostHog answers newest-first", async () => {
    const { client } = fakeClient(() =>
      Response.json({
        columns: ["timestamp", "service_name", "severity_text", "body"],
        results: [
          ["2026-10-20T12:31:00.000000+02:00", "threa-backend", "warn", "late"],
          ["2026-10-20T12:30:00.000000+02:00", "threa-control-plane", "error", "boom"],
        ],
      })
    )
    expect(
      await client.logs({ minSeverity: 13, after: "2026-10-20T10:00:00Z", before: "2026-10-20T11:00:00Z", limit: 5 })
    ).toEqual([
      {
        timestamp: "2026-10-20T10:30:00.000Z",
        severity: "error",
        message: "boom",
        service: "control-plane",
        attributes: {},
      },
      { timestamp: "2026-10-20T10:31:00.000Z", severity: "warn", message: "late", service: "backend", attributes: {} },
    ])
  })

  test("should label exception groups from their JSON arrays and tolerate unparsable values", async () => {
    const { client } = fakeClient(() =>
      Response.json({
        columns: ["issue_id", "lib", "types", "vals", "since", "prior", "last"],
        results: [["", "web", '["TypeError"]', "not json", 3, 1, "2026-10-20T13:00:00.000000+02:00"]],
      })
    )
    expect(
      await client.exceptionGroups({ priorStart: "2026-10-20T08:00:00Z", since: "2026-10-20T10:00:00Z", limit: 5 })
    ).toEqual([
      exception({ issueId: null, lib: "web", value: "", since: 3, prior: 1, lastAt: "2026-10-20T11:00:00.000Z" }),
    ])
  })

  test("should surface the server's error text when a query is rejected", async () => {
    const { client } = fakeClient(
      () => new Response(JSON.stringify({ detail: "Unknown table 'logz'" }), { status: 400 })
    )
    await expect(client.hogql("select 1 from logz")).rejects.toThrow(`posthog 400: {"detail":"Unknown table 'logz'"}`)
  })

  test("should throw when a 200 carries no results", async () => {
    const { client } = fakeClient(() => Response.json({ columns: [] }))
    await expect(client.hogql("select 1")).rejects.toThrow("posthog 200: no results")
  })
})

describe("summarizePostHog", () => {
  test("should reuse the log summariser with posthog-prefixed ids for the PostHog services", () => {
    const errSince = ["a", "b", "c"].map((m, i) => logLine(`2026-10-20T11:0${i}:00.000Z`, `job failed ${m}`))
    const report = summarizePostHog(window, { ...base, errSince })
    expect({
      services: report.logs.services.map((s) => s.service),
      findings: report.findings.map((f) => f.id),
    }).toEqual({ services: ["backend", "control-plane"], findings: ["posthog.logs.error.new.backend"] })
  })

  test("should drop log rate findings and say why when the prior window predates retention", () => {
    const errSince = Array.from({ length: 30 }, (_, i) => logLine("2026-10-20T11:00:00.000Z", `boom ${"x".repeat(i)}`))
    const report = summarizePostHog(window, { ...base, errSince, retainedFrom: "2026-10-20T09:00:00.000Z" })
    expect({ retainedFrom: report.retainedFrom, findings: report.findings }).toEqual({
      retainedFrom: "2026-10-20T09:00:00.000Z",
      findings: [
        {
          level: "warn",
          id: "posthog.logs.prior_incomplete",
          message:
            "PostHog retains logs from 2026-10-20 09:00Z; the prior window starts earlier, so log rate findings are skipped (use --since <= half the retention)",
        },
      ],
    })
  })

  test("should flag a rate jump and a new issue when exceptions grow", () => {
    const report = summarizePostHog(window, {
      ...base,
      exceptions: [
        exception({ issueId: "steady", since: 5, prior: 5 }),
        exception({ issueId: null, type: "RangeError", since: 2, prior: 0 }),
        exception({ issueId: "jump", since: 30, prior: 4 }),
      ],
      exceptionsTruncated: true,
    })
    expect({ order: report.exceptions.map((e) => e.since), findings: report.findings }).toEqual({
      order: [30, 5, 2],
      findings: [
        {
          level: "warn",
          id: "posthog.exception.jump",
          message: "exception ×30 since baseline vs 4 in the prior window [posthog-node] TypeError: x is undefined",
        },
        {
          level: "warn",
          id: "posthog.exception.new.posthog-node.RangeError",
          message: "new exception ×2 [posthog-node] RangeError: x is undefined",
        },
        {
          level: "warn",
          id: "posthog.exceptions.truncated",
          message: "exception fetch hit the 1000-group cap; quieter issues are missing",
        },
      ],
    })
  })

  test("should leave an issue alone when its rate is steady", () => {
    const report = summarizePostHog(window, { ...base, exceptions: [exception({ since: 15, prior: 12 })] })
    expect(report.findings).toEqual([])
  })
})
