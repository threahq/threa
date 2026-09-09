import { describe, expect, test } from "bun:test"
import { resolveRunPlan } from "./test-silent"

describe("resolveRunPlan", () => {
  test("refuses a full local run when no patterns are given", () => {
    expect(resolveRunPlan("backend-unit", [], {})).toEqual({
      action: "refuse",
      message:
        "Refusing to run the full backend-unit suite locally. Pass file paths or patterns to target your change, or --all to run everything. CI runs the full suite on push.",
    })
  })

  test("--all allows the run, takes the lock and is not forwarded", () => {
    expect(resolveRunPlan("backend-unit", ["--all", "--verbose"], {})).toEqual({
      action: "run",
      args: ["--verbose"],
      lock: true,
    })
  })

  test("patterns allow a lock-free run", () => {
    expect(resolveRunPlan("frontend", ["src/lib/dates.test.ts"], {})).toEqual({
      action: "run",
      args: ["src/lib/dates.test.ts"],
      lock: false,
    })
  })

  test("browser mode takes the lock even when targeted", () => {
    expect(resolveRunPlan("browser", ["tests/browser/aside-desktop.spec.ts"], {})).toEqual({
      action: "run",
      args: ["tests/browser/aside-desktop.spec.ts"],
      lock: true,
    })
  })

  test("CI runs everything without the lock", () => {
    expect(resolveRunPlan("backend-unit", [], { CI: "1" })).toEqual({
      action: "run",
      args: [],
      lock: false,
    })
  })
})
