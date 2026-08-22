import { describe, expect, test } from "bun:test"
import type { RailwayLogLine } from "../railway"
import { makeWindow } from "../types"
import { collapseContinuations, groupTemplates, summarizeLogs, templateOf } from "./logs"

const line = (message: string, over: Partial<RailwayLogLine> = {}): RailwayLogLine => ({
  timestamp: "2026-08-21T17:40:00.000Z",
  severity: "error",
  message,
  service: "backend",
  attributes: {},
  ...over,
})

describe("templateOf", () => {
  test("collapses ulids, uuids, timestamps, hex and numbers", () => {
    expect(
      templateOf(
        "job queue_01M0JPKAYNB3XYS90BRGF8TABCD failed after 3 attempts in 120ms at 2026-08-21T17:40:00.000Z id 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"
      )
    ).toBe("job <id> failed after <n> attempts in <n> at <ts> id <uuid>")
  })
})

describe("collapseContinuations", () => {
  test("folds stack frames and blank lines into the preceding event per service and drops orphans", () => {
    const lines = [
      line("      at orphan (x.js:1:1)"),
      line("Error: boom"),
      line("      at a (x.js:1:1)"),
      line("      at b (x.js:2:2)"),
      line(""),
      line("cp warning", { service: "control-plane" }),
      line("      at c (x.js:3:3)"),
      line("next event"),
    ]
    const out = collapseContinuations(lines)
    expect(out.map((l) => [l.service, l.message.split("\n")[0]])).toEqual([
      ["backend", "Error: boom"],
      ["control-plane", "cp warning"],
      ["backend", "next event"],
    ])
    expect(out[0].message).toBe("Error: boom\n      at a (x.js:1:1)\n      at b (x.js:2:2)\n      at c (x.js:3:3)")
  })
})

describe("groupTemplates", () => {
  test("counts events by template, newest-heavy first, with services and noise tagging", () => {
    const lines = [
      line("Memo batch failed for stream_01M0JPKAYNB3XYS90BRGF8TABCD"),
      line("Memo batch failed for stream_01M0JPKAYNB3XYS90BRGF8TABCE", {
        service: "enclave",
        timestamp: "2026-08-21T17:41:00.000Z",
      }),
      line(
        "(node:1) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated"
      ),
    ]
    const groups = groupTemplates(lines)
    expect(groups.map((g) => [g.template, g.count, g.services, g.noise !== null])).toEqual([
      ["Memo batch failed for <id>", 2, ["backend", "enclave"], false],
      [
        "(node:<n>) DeprecationWarning: Calling client.query() when the client is already executing a query is deprecated",
        1,
        ["backend"],
        true,
      ],
    ])
    expect(groups[0].lastAt).toBe("2026-08-21T17:41:00.000Z")
  })
})

describe("summarizeLogs", () => {
  const window = makeWindow(new Date("2026-08-21T17:00:00Z"), new Date("2026-08-21T18:00:00Z"), 0, "test")
  test("a burst with no prior history and a repeated new template become findings; noise is counted apart", () => {
    const errSince = [
      ...Array.from({ length: 3 }, (_, i) => line(`Pull failed for track_01M0JPKAYNB3XYS90BRGF8TAB${i}`)),
      line("(node:1) DeprecationWarning: Calling client.query() when the client is already executing a query"),
    ]
    const report = summarizeLogs(window, { errSince, errPrior: [], warnSince: [], warnPrior: [] })
    expect(report.services.find((s) => s.service === "backend")).toEqual({
      service: "backend",
      errorSince: 3,
      errorPrior: 0,
      warnSince: 0,
      warnPrior: 0,
      noiseSince: 1,
    })
    expect(report.findings.map((f) => f.id)).toEqual(["logs.error.new.backend", "logs.template.Pull failed for <id>"])
  })
  test("a template already present in the prior window is not new, and steady rates do not warn", () => {
    const mk = (n: number) => Array.from({ length: n }, () => line("Pull failed for track_01M0JPKAYNB3XYS90BRGF8TAB1"))
    const report = summarizeLogs(window, { errSince: mk(12), errPrior: mk(11), warnSince: [], warnPrior: [] })
    expect(report.findings).toEqual([])
  })
  test("error rate above the multiplier of the prior window warns", () => {
    const mk = (n: number) => Array.from({ length: n }, () => line("Pull failed for track_01M0JPKAYNB3XYS90BRGF8TAB1"))
    const report = summarizeLogs(window, { errSince: mk(30), errPrior: mk(12), warnSince: [], warnPrior: [] })
    expect(report.findings.map((f) => f.id)).toEqual(["logs.error.backend"])
  })
})
