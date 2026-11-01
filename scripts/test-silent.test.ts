import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { listTestFiles, partitionFiles, resolveRunPlan, takeWorkersOption } from "./test-silent"

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

describe("worker runs", () => {
  test("--workers is taken out of the forwarded args in either form", () => {
    expect([
      takeWorkersOption(["tests/e2e/", "--workers", "2", "--bail"]),
      takeWorkersOption(["--workers=1"]),
      takeWorkersOption([]).workers,
    ]).toEqual([{ workers: 2, args: ["tests/e2e/", "--bail"] }, { workers: 1, args: [] }, 4])
    expect(() => takeWorkersOption(["--workers", "0"])).toThrow("--workers needs a positive integer, got 0")
  })

  test("lists test files under paths and leaves name filters to bun", () => {
    const root = mkdtempSync(path.join(tmpdir(), "test-silent-files-"))
    try {
      mkdirSync(path.join(root, "tests/e2e/nested"), { recursive: true })
      mkdirSync(path.join(root, "tests/e2e/node_modules/pkg"), { recursive: true })
      for (const file of ["a.test.ts", "nested/b_spec.tsx", "helpers.ts", "node_modules/pkg/c.test.ts"]) {
        writeFileSync(path.join(root, "tests/e2e", file), "")
      }
      writeFileSync(path.join(root, "solo.test.ts"), "")
      expect([
        listTestFiles(root, ["tests/e2e/", "./solo.test.ts", "tests/e2e/a.test.ts"]),
        listTestFiles(root, ["tests/e2e/", "streams"]),
      ]).toEqual([["solo.test.ts", "tests/e2e/a.test.ts", "tests/e2e/nested/b_spec.tsx"], undefined])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("puts the heaviest files on separate workers and never makes an empty one", () => {
    const weights: Record<string, number> = { a: 9, b: 8, c: 3, d: 3, e: 2, f: 1 }
    expect([
      partitionFiles(Object.keys(weights), 3, (file) => weights[file]!),
      partitionFiles(["a", "b"], 4, () => 1),
    ]).toEqual([
      [["a"], ["b", "f"], ["c", "d", "e"]],
      [["a"], ["b"]],
    ])
  })
})
