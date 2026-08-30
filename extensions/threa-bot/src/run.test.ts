import { describe, expect, test } from "bun:test"
import { StepBatcher, resolveConfig } from "./run"

describe("StepBatcher", () => {
  test("coalesces lines into serialized flushes, chunked at the frame cap, and reports send failures", async () => {
    const sent: number[] = []
    let inFlight = 0
    let peak = 0
    const errors: unknown[] = []
    const batcher = new StepBatcher(
      async (frames) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        sent.push(frames.length)
        if (sent.length === 2) throw new Error("socket hiccup")
      },
      { flushMs: 10, onError: (error) => errors.push(error) }
    )
    for (let i = 0; i < 120; i++) batcher.push(`line ${i}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await batcher.flush()
    expect(sent.reduce((a, b) => a + b, 0)).toBe(120)
    expect(Math.max(...sent)).toBeLessThanOrEqual(50)
    expect(peak).toBe(1)
    expect(errors).toHaveLength(1)
  })
})

describe("resolveConfig", () => {
  const deps = { cwd: "/tmp/project", log: () => undefined }
  test("names the scratchpad after the command unless --name is given", () => {
    const env = { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" }
    const byCommand = resolveConfig(
      { kind: "run", command: ["/usr/bin/my-agent", "--x"], mode: "scratchpad" },
      { ...deps, env }
    )
    expect(byCommand.displayName).toBe("my-agent - project")
    const named = resolveConfig({ kind: "run", command: ["x"], mode: "scratchpad", name: "Ops" }, { ...deps, env })
    expect(named.displayName).toBe("Ops - project")
    expect(named.instanceId).toStartWith("bot-")
    expect(named.runtimeSessionId).toStartWith("bots-")
  })

  test("explains what is missing", () => {
    expect(() => resolveConfig({ kind: "run", command: ["x"], mode: "scratchpad" }, { ...deps, env: {} })).toThrow(
      "THREA_WORKSPACE_ID, THREA_API_KEY"
    )
  })
})
