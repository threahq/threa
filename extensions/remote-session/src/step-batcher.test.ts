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

  test("flushes on its own after the delay", async () => {
    const steps = recorder()
    new StepBatcher("binv_1", steps).add(frame("a"))

    await Bun.sleep(600)

    expect(steps.batches).toEqual([{ invocationId: "binv_1", contents: ["a"] }])
  })
})
