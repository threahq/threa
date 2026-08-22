import { describe, expect, test } from "bun:test"
import type { WorkflowRun } from "../github"
import type { RailwayDeployment } from "../railway"
import { buildRevisionReport, evaluateFrontendPlane, evaluateRailwayPlane, summarizeRailway } from "./revision"

const dep = (over: Partial<RailwayDeployment>): RailwayDeployment => ({
  id: "d",
  status: "SUCCESS",
  createdAt: "2026-08-21T17:39:43.000Z",
  staticUrl: null,
  service: "backend",
  sha: "1ff063b5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  commitMessage: "feat",
  skippedReason: null,
  ...over,
})
const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  workflowName: "CI",
  status: "completed",
  conclusion: "success",
  headSha: "1ff063b5",
  createdAt: "2026-08-21T17:39:00Z",
  url: "https://gh/run/1",
  databaseId: 1,
  ...over,
})
const EXPECTED = "1ff063b5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

describe("summarizeRailway", () => {
  test("keeps the newest deployment and the newest SUCCESS per service", () => {
    const s = summarizeRailway([
      dep({ id: "old-ok", createdAt: "2026-08-20T10:00:00Z", sha: "f850d746" }),
      dep({
        id: "new-skip",
        status: "SKIPPED",
        createdAt: "2026-08-21T17:00:00Z",
        service: "control-plane",
        skippedReason: "No changes",
      }),
      dep({ id: "cp-ok", createdAt: "2026-08-20T10:00:00Z", service: "control-plane", sha: "f850d746" }),
      dep({ id: "new-ok" }),
    ])
    expect(s.get("backend")).toMatchObject({ newest: { id: "new-ok" }, serving: { id: "new-ok" } })
    expect(s.get("control-plane")).toMatchObject({ newest: { id: "new-skip" }, serving: { id: "cp-ok" } })
  })
})

describe("evaluateRailwayPlane", () => {
  test("SUCCESS at the expected sha is ok", () => {
    expect(evaluateRailwayPlane("backend", EXPECTED, { newest: dep({}), serving: dep({}) })).toMatchObject({
      level: "ok",
      live: EXPECTED,
    })
  })
  test("SKIPPED at the expected sha is ok and names what is actually serving", () => {
    const serving = dep({ sha: "f850d746bbbb", createdAt: "2026-08-20T10:00:00Z" })
    const r = evaluateRailwayPlane("control-plane", EXPECTED, {
      newest: dep({ status: "SKIPPED", skippedReason: "No changes to watched files" }),
      serving,
    })
    expect(r).toMatchObject({ level: "ok", live: "f850d746bbbb" })
    expect(r.detail).toContain("No changes to watched files")
  })
  test("expected sha not yet on Railway is pending, a FAILED newest is fail, BUILDING is pending", () => {
    const serving = dep({ sha: "f850d746bbbb" })
    expect(evaluateRailwayPlane("backend", EXPECTED, { newest: serving, serving }).level).toBe("pending")
    expect(evaluateRailwayPlane("backend", EXPECTED, { newest: dep({ status: "FAILED" }), serving }).level).toBe("fail")
    expect(evaluateRailwayPlane("backend", EXPECTED, { newest: dep({ status: "BUILDING" }), serving }).level).toBe(
      "pending"
    )
    expect(evaluateRailwayPlane("backend", EXPECTED, undefined).level).toBe("fail")
  })
})

describe("evaluateFrontendPlane", () => {
  test("version.json short sha matching the expected prefix is ok without consulting GitHub", () => {
    expect(evaluateFrontendPlane(EXPECTED, { version: "1ff063b" }, []).level).toBe("ok")
  })
  test("CI failure explains why the deploy will never come", () => {
    const r = evaluateFrontendPlane(EXPECTED, { version: "f850d74" }, [run({ conclusion: "failure" })])
    expect(r.level).toBe("fail")
    expect(r.detail).toContain("Deploy Cloudflare will not run")
    expect(r.detail).toContain("https://gh/run/1")
  })
  test("CI green with no deploy run yet, or a running deploy, is pending; a green deploy with stale version.json is warn", () => {
    expect(evaluateFrontendPlane(EXPECTED, { version: "f850d74" }, [run({})]).level).toBe("pending")
    expect(
      evaluateFrontendPlane(EXPECTED, { version: "f850d74" }, [
        run({}),
        run({ workflowName: "Deploy Cloudflare", status: "in_progress", conclusion: null }),
      ]).level
    ).toBe("pending")
    expect(
      evaluateFrontendPlane(EXPECTED, { version: "f850d74" }, [run({}), run({ workflowName: "Deploy Cloudflare" })])
        .level
    ).toBe("warn")
    expect(evaluateFrontendPlane(EXPECTED, null, []).level).toBe("pending")
  })
  test("the newest run per workflow wins over an older rerun", () => {
    const runs = [
      run({ conclusion: "failure", createdAt: "2026-08-21T17:00:00Z" }),
      run({ conclusion: "success", createdAt: "2026-08-21T17:30:00Z" }),
    ]
    expect(evaluateFrontendPlane(EXPECTED, { version: "f850d74" }, runs).level).toBe("pending")
  })
})

test("buildRevisionReport lists every plane, collects non-ok findings and the backend deploy time", () => {
  const report = buildRevisionReport({
    expected: EXPECTED,
    deployments: [
      dep({}),
      dep({ service: "control-plane", status: "SKIPPED", skippedReason: "No changes" }),
      dep({ service: "control-plane", createdAt: "2026-08-20T10:00:00Z", sha: "f850d746" }),
      dep({ service: "enclave" }),
      dep({ service: "db-read-proxy", status: "FAILED" }),
    ],
    frontendVersion: { version: "1ff063b" },
    runs: [],
  })
  expect(report.planes.map((p) => [p.plane, p.level])).toEqual([
    ["frontend", "ok"],
    ["backend", "ok"],
    ["control-plane", "ok"],
    ["enclave", "ok"],
    ["db-read-proxy", "fail"],
  ])
  expect(report.findings.map((f) => f.id)).toEqual(["revision.db-read-proxy"])
  expect(report.backendDeployedAt).toBe("2026-08-21T17:39:43.000Z")
})

test("without Railway access the Railway planes are skipped rather than failed", () => {
  const report = buildRevisionReport({
    expected: EXPECTED,
    deployments: null,
    frontendVersion: { version: "1ff063b" },
    runs: [],
  })
  expect(report.planes.map((p) => p.level)).toEqual(["ok", "skipped", "skipped", "skipped", "skipped"])
  expect(report.findings.map((f) => f.level)).toEqual(["skipped", "skipped", "skipped", "skipped"])
})
