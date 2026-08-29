import { describe, expect, test } from "bun:test"
import { StepBatcher, resolveConfig } from "./run"

describe("StepBatcher", () => {
  test("coalesces lines into one flush and chunks at the frame cap", async () => {
    const sent: number[] = []
    const batcher = new StepBatcher(async (frames) => void sent.push(frames.length), 10)
    for (let i = 0; i < 120; i++) batcher.push(`line ${i}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await batcher.flush()
    expect(sent.reduce((a, b) => a + b, 0)).toBe(120)
    expect(Math.max(...sent)).toBeLessThanOrEqual(50)
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
