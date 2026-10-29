import { describe, expect, test } from "bun:test"
import type { JSONReport, JSONReportTestResult, JSONReportTest } from "@playwright/test/reporter"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { main, planShards } from "./browser-ci"

function report(
  specs: Array<{
    file: string
    project?: string
    title?: string
    results?: Array<Pick<JSONReportTestResult, "status" | "duration" | "retry">>
    expectedStatus?: JSONReportTest["expectedStatus"]
  }>
): JSONReport {
  return {
    suites: [
      {
        title: "",
        file: "",
        column: 0,
        line: 0,
        specs: specs.map((spec, index) => ({
          title: spec.title ?? `test ${index}`,
          ok: true,
          tags: [],
          id: String(index),
          file: spec.file,
          line: 1,
          column: 1,
          tests: [
            {
              timeout: 1,
              annotations: [],
              expectedStatus: spec.expectedStatus ?? "passed",
              projectName: spec.project ?? "chromium",
              projectId: spec.project ?? "chromium",
              results: (spec.results ?? []).map((result) => ({
                workerIndex: 0,
                parallelIndex: 0,
                error: undefined,
                errors: [],
                stdout: [],
                stderr: [],
                startTime: new Date().toISOString(),
                attachments: [],
                annotations: [],
                ...result,
              })),
              status: "expected",
            },
          ],
        })),
      },
    ],
    stats: { startTime: new Date().toISOString(), duration: 1, expected: 0, skipped: 0, unexpected: 0, flaky: 0 },
    config: {} as JSONReport["config"],
    errors: [],
  }
}

describe("browser CI reporting", () => {
  test("should keep first-attempt failures visible when a retry passes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "browser-ci-"))
    const input = path.join(dir, "report.json")
    const output = path.join(dir, "summary.md")
    writeFileSync(
      input,
      JSON.stringify(
        report([
          {
            file: "retry.spec.ts",
            title: "eventually works",
            results: [
              { status: "failed", duration: 10, retry: 0 },
              { status: "passed", duration: 5, retry: 1 },
            ],
          },
        ])
      )
    )
    main(["report", "--report", input, "--shard", "1", "--output", output])
    expect(readFileSync(output, "utf8")).toContain("Passed/attempted: **0/1**")
    expect(readFileSync(output, "utf8")).toContain("eventually works")
  })

  test("should report skipped tests and reject partial execution", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "browser-ci-"))
    const input = path.join(dir, "report.json")
    const output = path.join(dir, "summary.md")
    writeFileSync(
      input,
      JSON.stringify(
        report([
          { file: "a.spec.ts", expectedStatus: "skipped", results: [{ status: "skipped", duration: 0, retry: 0 }] },
          { file: "b.spec.ts" },
        ])
      )
    )
    expect(() => main(["report", "--report", input, "--shard", "2", "--output", output])).toThrow(
      "report contains 1 unexecuted tests"
    )
    expect(readFileSync(output, "utf8")).toContain("skipped: **1** · unexecuted: **1**")
  })

  test("should reject malformed reports instead of reporting full reliability", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "browser-ci-"))
    const input = path.join(dir, "report.json")
    writeFileSync(input, "not json")
    expect(() => main(["report", "--report", input, "--shard", "1", "--output", path.join(dir, "out")])).toThrow()
  })

  test("should mark an empty startup report unavailable and refuse to publish empty timings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "browser-ci-"))
    const artifact = path.join(dir, "shard-result-1-attempt-1")
    mkdirSync(artifact)
    const input = path.join(artifact, "initial-report.json")
    const empty = report([])
    empty.suites = []
    writeFileSync(input, JSON.stringify(empty))

    expect(() => main(["report", "--report", input, "--shard", "1", "--output", path.join(dir, "summary.md")])).toThrow(
      "report contains no tests"
    )
    expect(() =>
      main(["merge-timings", "--reports-dir", dir, "--shards", "1", "--output", path.join(dir, "history.json")])
    ).toThrow("reports contain no usable timings")
  })
})

describe("browser CI shard planning", () => {
  test("should use count balancing when history has no positive observations", () => {
    const inventory = report(Array.from({ length: 8 }, (_, index) => ({ file: `f${index}.spec.ts` })))
    const expected = planShards(inventory, undefined, 4)

    expect(planShards(inventory, { version: 1, groups: {} }, 4)).toEqual(expected)
    expect(
      planShards(inventory, { version: 1, groups: { "[chromium] > f0.spec.ts": { durationMs: 0, testCount: 1 } } }, 4)
    ).toEqual(expected)
  })
  test("should assign new tests exactly once in a deterministic balanced partition", () => {
    const inventory = report(Array.from({ length: 8 }, (_, index) => ({ file: `f${index}.spec.ts` })))
    const history = {
      version: 1 as const,
      groups: Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [
          `[chromium] > f${index}.spec.ts`,
          { durationMs: 8 - index, testCount: 1 },
        ])
      ),
    }
    const first = planShards(inventory, history, 4)
    const second = planShards(inventory, history, 4)
    expect(first).toEqual(second)
    expect(first.shards.flatMap((shard) => shard.groups).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `[chromium] > f${index}.spec.ts`).sort()
    )
    expect(first.fallbackGroupCount).toBe(1)
    const durations = first.shards.map((shard) => shard.estimatedDurationMs)
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThanOrEqual(1)
  })

  test("should reject duplicate or missing initial shard reports", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "browser-ci-"))
    const artifact = path.join(dir, "shard-result-1-attempt-1")
    mkdirSync(artifact)
    writeFileSync(
      path.join(artifact, "initial-report.json"),
      JSON.stringify(report([{ file: "a.spec.ts", results: [{ status: "passed", duration: 1, retry: 0 }] }]))
    )
    expect(() =>
      main(["merge-timings", "--reports-dir", dir, "--shards", "2", "--output", path.join(dir, "history.json")])
    ).toThrow("expected 2")

    const duplicate = path.join(dir, "shard-result-1-attempt-2")
    mkdirSync(duplicate)
    writeFileSync(
      path.join(duplicate, "initial-report.json"),
      JSON.stringify(report([{ file: "b.spec.ts", results: [{ status: "passed", duration: 1, retry: 0 }] }]))
    )
    expect(() =>
      main(["merge-timings", "--reports-dir", dir, "--shards", "2", "--output", path.join(dir, "history.json")])
    ).toThrow("duplicate initial report for shard 1")
  })

  test("should use the first passing attempt for timing history", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "browser-ci-"))
    for (let shard = 1; shard <= 2; shard++) {
      const artifact = path.join(dir, `shard-result-${shard}-attempt-3`)
      mkdirSync(artifact)
      writeFileSync(
        path.join(artifact, "initial-report.json"),
        JSON.stringify(
          report([
            {
              file: `shard-${shard}.spec.ts`,
              results: [
                { status: "failed", duration: 1000, retry: 0 },
                { status: "passed", duration: shard * 10, retry: 1 },
                { status: "passed", duration: shard * 100, retry: 2 },
              ],
            },
          ])
        )
      )
    }
    const output = path.join(dir, "history.json")
    main(["merge-timings", "--reports-dir", dir, "--shards", "2", "--output", output])
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      version: 1,
      groups: {
        "[chromium] > shard-1.spec.ts": { durationMs: 10, testCount: 1 },
        "[chromium] > shard-2.spec.ts": { durationMs: 20, testCount: 1 },
      },
    })
  })
})
