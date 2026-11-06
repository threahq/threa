import { describe, expect, test } from "bun:test"
import type { PostHogReport } from "./probes/posthog"
import { diffFindings, renderPostHog } from "./render"
import { makeWindow } from "./types"

describe("diffFindings", () => {
  test("keys on id: new ids are added, a level change is changed, a changed message alone is neither, vanished ids are resolved", () => {
    const prev = [
      { level: "warn" as const, id: "a", message: "a v1" },
      { level: "warn" as const, id: "b", message: "b" },
    ]
    const next = [
      { level: "fail" as const, id: "a", message: "a v2" },
      { level: "fail" as const, id: "c", message: "c" },
    ]
    const diff = diffFindings(prev, next)
    expect(diff).toEqual({
      added: [{ level: "fail", id: "c", message: "c" }],
      changed: [{ level: "fail", id: "a", message: "a v2" }],
      resolved: [{ level: "warn", id: "b", message: "b" }],
    })
    expect(diffFindings(next, [{ level: "fail", id: "a", message: "a v3 (lag 42)" }, next[1]])).toEqual({
      added: [],
      changed: [],
      resolved: [],
    })
  })
})

describe("renderPostHog", () => {
  test("prints the logs block under the posthog label and exceptions in report order", () => {
    const window = makeWindow(new Date("2026-10-13T20:00:00Z"), new Date("2026-10-20T20:00:00Z"), 0, "since --since")
    const exception = { issueId: null, lib: "web", lastAt: "2026-10-20T18:49:23.934Z" }
    const report: PostHogReport = {
      window,
      logs: {
        window,
        services: [{ service: "backend", errorSince: 3, errorPrior: 1, warnSince: 9, warnPrior: 4, noiseSince: 0 }],
        templates: [],
        truncated: false,
        findings: [],
      },
      exceptions: [
        { ...exception, lib: "posthog-node", type: "Error", value: "pool exhausted", since: 7, prior: 5 },
        { ...exception, type: "TypeError", value: "x is undefined", since: 2, prior: 0 },
      ],
      retainedFrom: "2026-10-06T21:15:00.000Z",
      findings: [],
    }
    expect(renderPostHog(report, 5)).toEqual([
      "posthog   since --since 10-13 20:00Z (7d window); prior window equal length",
      "  backend        error 3 (prior 1)  warn 9 (prior 4)",
      "  logs retained from 2026-10-06 21:15Z",
      "  exceptions:",
      "    ×7 (prior 5) [posthog-node] Error: pool exhausted  last 10-20 18:49Z",
      "    ×2 (prior 0) [web] TypeError: x is undefined  last 10-20 18:49Z",
    ])
  })
})
