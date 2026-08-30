import { describe, expect, test } from "bun:test"
import { StepBatcher, resolveConfig } from "./run"

describe("StepBatcher", () => {
  test("coalesces lines into serialized flushes, chunked at the frame cap, and reports send failures", async () => {
    const sent: number[] = []
    let inFlight = 0
    let peak = 0
    const errors: string[] = []
    const batcher = new StepBatcher({ flushMs: 10, onError: (_id, error) => errors.push(String(error)) })
    batcher.begin("binv_1", async (frames) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      sent.push(frames.length)
      if (sent.length === 2) throw new Error("socket hiccup")
    })
    for (let i = 0; i < 120; i++) batcher.push("binv_1", `line ${i}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await batcher.finish("binv_1")
    expect(sent.reduce((a, b) => a + b, 0)).toBe(120)
    expect(Math.max(...sent)).toBeLessThanOrEqual(50)
    expect(peak).toBe(1)
    expect(errors).toEqual(["Error: socket hiccup"])
  })

  test("one stuck send blocks the whole process, later turns drop their lines at the deadline instead of starting more", async () => {
    const errors: string[] = []
    let calls = 0
    const stuck = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 60_000))
    }
    const batcher = new StepBatcher({
      flushMs: 60_000,
      onError: (id, error) => errors.push(`${id}: ${(error as Error).message}`),
    })
    batcher.begin("binv_1", stuck)
    // The first 50 go out in the one stuck send; 570 more arrive, the cap keeps 500 of them.
    for (let i = 0; i < 620; i++) batcher.push("binv_1", `line ${i}`)
    expect(batcher.dropped.get("binv_1")).toBe(70)
    const started = Date.now()
    await batcher.finish("binv_1", 50)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(calls).toBe(1)
    expect(errors).toEqual([`binv_1: ${70 + 500} trace lines dropped`])
    batcher.push("binv_1", "late")
    expect(batcher.dropped.has("binv_1")).toBe(false)

    let secondSends = 0
    batcher.begin("binv_2", async () => void (secondSends += 1))
    batcher.push("binv_2", "hello")
    await batcher.finish("binv_2", 50)
    expect(secondSends).toBe(0)
    expect(calls).toBe(1)
    expect(errors.at(-1)).toBe("binv_2: 1 trace lines dropped")
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
