import { describe, expect, it } from "bun:test"
import { listSpawnRuntimes, spawnRuntimesResolver } from "./spawn-runtimes"

describe("listSpawnRuntimes", () => {
  it("returns the runtimes harnessd reports as installed", () => {
    const calls: unknown[][] = []
    const result = listSpawnRuntimes({
      entrypoint: "/repo/extensions/harness-daemon/src/index.ts",
      bunExecutable: "/opt/bun/bin/bun",
      exists: () => true,
      spawnSync: (executable, args, options) => {
        calls.push([executable, args, options])
        return {
          status: 0,
          stdout: JSON.stringify([
            { value: "claude", label: "Claude Code", description: "/usr/local/bin/claude" },
            { value: "pi", label: "Pi", description: "/usr/local/bin/pi" },
          ]),
          stderr: "",
        }
      },
    })

    expect(result).toEqual({
      ok: true,
      runtimes: [
        { value: "claude", label: "Claude Code", description: "/usr/local/bin/claude" },
        { value: "pi", label: "Pi", description: "/usr/local/bin/pi" },
      ],
    })
    expect(calls).toEqual([
      ["/opt/bun/bin/bun", ["/repo/extensions/harness-daemon/src/index.ts", "runtimes"], { encoding: "utf8" }],
    ])
  })

  it("treats a missing harness daemon as nothing spawnable", () => {
    expect(
      listSpawnRuntimes({
        entrypoint: "/missing/index.ts",
        exists: () => false,
      })
    ).toEqual({ ok: true, runtimes: [] })
  })

  it("fails loudly on a non-zero exit", () => {
    const result = listSpawnRuntimes({
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: () => ({
        status: 1,
        stdout: "",
        stderr: "harnessd: boom\n",
      }),
    })

    expect(result).toEqual({ ok: false, error: "harnessd: boom" })
  })

  it("fails loudly when the bun executable is missing", () => {
    const result = listSpawnRuntimes({
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: () => ({
        status: null,
        error: new Error("spawnSync /missing/bun ENOENT"),
      }),
    })

    expect(result).toEqual({ ok: false, error: "spawnSync /missing/bun ENOENT" })
  })

  it("fails loudly on unparseable stdout", () => {
    const result = listSpawnRuntimes({
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: () => ({ status: 0, stdout: "not json", stderr: "" }),
    })

    expect(result).toEqual({ ok: false, error: "harnessd runtimes returned unparseable output: not json" })
  })

  it("fails loudly on wrong-shaped stdout", () => {
    const result = listSpawnRuntimes({
      entrypoint: "/repo/index.ts",
      exists: () => true,
      spawnSync: () => ({ status: 0, stdout: JSON.stringify([{ value: "claude" }]), stderr: "" }),
    })

    expect(result).toEqual({
      ok: false,
      error: 'harnessd runtimes returned unexpected output: [{"value":"claude"}]',
    })
  })
})

describe("spawnRuntimesResolver", () => {
  it("runs harnessd once and keeps the answer, reporting a failure once and staying empty", () => {
    const runtimes = [{ value: "pi", label: "Pi", description: "/usr/local/bin/pi" }]
    let spawns = 0
    const resolve = spawnRuntimesResolver(() => {}, {
      entrypoint: "/repo/harnessd.ts",
      exists: () => true,
      spawnSync: () => {
        spawns += 1
        return { status: 0, stdout: JSON.stringify(runtimes), stderr: "" }
      },
    })
    const errors: string[] = []
    let failures = 0
    const resolveFailing = spawnRuntimesResolver((error) => errors.push(error), {
      entrypoint: "/repo/harnessd.ts",
      exists: () => true,
      spawnSync: () => {
        failures += 1
        return { status: 1, stdout: "", stderr: "harnessd: unknown command: runtimes" }
      },
    })

    expect({
      first: resolve(),
      second: resolve(),
      spawns,
      failing: [resolveFailing(), resolveFailing()],
      failures,
      errors,
    }).toEqual({
      first: runtimes,
      second: runtimes,
      spawns: 1,
      failing: [[], []],
      failures: 1,
      errors: ["harnessd: unknown command: runtimes"],
    })
  })
})
