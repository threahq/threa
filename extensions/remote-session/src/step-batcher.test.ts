import { describe, expect, test } from "bun:test"
import type { StepFrame } from "@threahq/bot-runtime-client"
import { StepBatcher } from "./step-batcher"

const frame = (content: string): StepFrame => ({ stepType: "thinking", content })

function recorder() {
  const batches: Array<{ invocationId: string; contents: string[] }> = []
  return {
    batches,
    recordSteps: async (invocationId: string, frames: StepFrame[]) => {
      batches.push({ invocationId, contents: frames.map((candidate) => candidate.content ?? "") })
      return true
    },
  }
}

describe("StepBatcher", () => {
  test("posts buffered frames as one batch, then an immediate frame on its own", async () => {
    const steps = recorder()
    const batcher = new StepBatcher("binv_1", steps)

    batcher.add(frame("a"))
    batcher.add(frame("b"))
    await batcher.flush()
    await batcher.addNow(frame("c"))
    await batcher.flush()

    expect(steps.batches).toEqual([
      { invocationId: "binv_1", contents: ["a", "b"] },
      { invocationId: "binv_1", contents: ["c"] },
    ])
  })

  test("a batch carries the chip of its latest frame", async () => {
    const chips: Array<string | undefined> = []
    const batcher = new StepBatcher("binv_1", {
      recordSteps: async (_invocationId, _frames, statusText) => chips.push(statusText),
    })

    batcher.add(frame("a"), "Running a command…")
    batcher.add(frame("b"), "Working…")
    await batcher.flush()
    await batcher.addNow(frame("c"))

    expect(chips).toEqual(["Working…", undefined])
  })

  test("flushes on its own after the delay", async () => {
    const steps = recorder()
    new StepBatcher("binv_1", steps).add(frame("a"))

    await Bun.sleep(600)

    expect(steps.batches).toEqual([{ invocationId: "binv_1", contents: ["a"] }])
  })

  test("a batch the recorder rejects fails only that flush", async () => {
    const steps = recorder()
    const record = steps.recordSteps
    let calls = 0
    const batcher = new StepBatcher("binv_1", {
      recordSteps: (invocationId, frames) =>
        ++calls === 1 ? Promise.reject(new Error("offline")) : record(invocationId, frames),
    })

    const failed = await batcher.addNow(frame("a")).catch((error: Error) => error.message)
    await batcher.addNow(frame("b"))

    expect({ failed, batches: steps.batches }).toEqual({
      failed: "offline",
      batches: [{ invocationId: "binv_1", contents: ["b"] }],
    })
  })
})
