import { describe, expect, it } from "bun:test"
import { runHarnessKick } from "./harness-kick"

describe("runHarnessKick", () => {
  it("runs harnessd kick against the runtime session id", () => {
    const calls: unknown[][] = []
    const result = runHarnessKick(" ccs_1 ", {
      entrypoint: "/repo/extensions/harness-daemon/src/index.ts",
      bunExecutable: "/opt/bun/bin/bun",
      exists: () => true,
      spawnSync: (executable, args, options) => {
        calls.push([executable, args, options])
        return { status: 0, stdout: "kicked", stderr: "" }
      },
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([
      ["/opt/bun/bin/bun", ["/repo/extensions/harness-daemon/src/index.ts", "kick", "ccs_1"], { encoding: "utf8" }],
    ])
  })

  it("fails loudly when the runtime is not in harnessd inventory", () => {
    const result = runHarnessKick("ccs_missing", {
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: () => ({
        status: 1,
        stdout: "",
        stderr: "harnessd: no agent found for ccs_missing\n",
      }),
    })

    expect(result).toEqual({ ok: false, error: "harnessd: no agent found for ccs_missing" })
  })

  it("reports a missing Bun executable", () => {
    const result = runHarnessKick("ccs_1", {
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: () => ({
        status: null,
        error: new Error("spawnSync /missing/bun ENOENT"),
      }),
    })

    expect(result).toEqual({ ok: false, error: "spawnSync /missing/bun ENOENT" })
  })

  it("does not spawn without a runtime session id or harnessd entrypoint", () => {
    expect(runHarnessKick("", { entrypoint: "/repo/index.ts", exists: () => true })).toEqual({
      ok: false,
      error: "Runtime session id is missing.",
    })
    expect(runHarnessKick("ccs_1", { entrypoint: "/missing/index.ts", exists: () => false })).toEqual({
      ok: false,
      error: "Harness daemon entrypoint not found: /missing/index.ts",
    })
  })
})
