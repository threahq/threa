import { describe, expect, it } from "bun:test"
import { runHarnessKick } from "./harness-kick"

describe("runHarnessKick", () => {
  it("runs harnessd kick against the runtime session id", () => {
    const calls: unknown[][] = []
    const result = runHarnessKick(" ccs_1 ", {
      entrypoint: "/repo/extensions/harness-daemon/src/index.ts",
      exists: () => true,
      spawnSync: ((command: string[], options: unknown) => {
        calls.push([command, options])
        return { exitCode: 0, stdout: Buffer.from("kicked"), stderr: Buffer.from("") }
      }) as typeof Bun.spawnSync,
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([
      [
        [process.execPath, "/repo/extensions/harness-daemon/src/index.ts", "kick", "ccs_1"],
        { stdout: "pipe", stderr: "pipe" },
      ],
    ])
  })

  it("fails loudly when the runtime is not in harnessd inventory", () => {
    const result = runHarnessKick("ccs_missing", {
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: (() => ({
        exitCode: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("harnessd: no agent found for ccs_missing\n"),
      })) as unknown as typeof Bun.spawnSync,
    })

    expect(result).toEqual({ ok: false, error: "harnessd: no agent found for ccs_missing" })
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
