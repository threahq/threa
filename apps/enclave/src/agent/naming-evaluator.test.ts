import { describe, expect, it, vi } from "vitest"
import type { EnclaveNamingInstruction } from "@threa/types"
import { evaluateNaming } from "./naming-evaluator"

const instruction: EnclaveNamingInstruction = {
  stateRevision: 4,
  titleRevision: 2,
  checkpoint: 3,
  messageCount: 3,
  forced: true,
  reason: "ordinary",
}

describe("evaluateNaming", () => {
  it("uses strict provider JSON and accepts rename", async () => {
    let request: Parameters<import("../llm").RawChatFn>[0] | undefined
    const rawChat: import("../llm").RawChatFn = vi.fn(async (value) => {
      request = value
      return {
        model: "stub",
        message: {
          content: JSON.stringify({ action: "rename", title: "Migration rollback records", confidence: 0.9 }),
        },
      }
    })
    await expect(
      evaluateNaming({ rawChat, model: "stub", instruction, currentTitle: null, context: "User: rollback failed" })
    ).resolves.toEqual({ action: "rename", title: "Migration rollback records", confidence: 0.9 })
    expect(request?.responseFormat?.type).toBe("json_schema")
  })

  it("rejects defer at a forced checkpoint and keep without a title", async () => {
    const response = (action: "defer" | "keep") => async () => ({
      model: "stub",
      message: { content: JSON.stringify({ action, title: "", confidence: 0.5 }) },
    })
    await expect(
      evaluateNaming({ rawChat: response("defer"), model: "stub", instruction, currentTitle: null, context: "x" })
    ).resolves.toBeNull()
    await expect(
      evaluateNaming({ rawChat: response("keep"), model: "stub", instruction, currentTitle: null, context: "x" })
    ).resolves.toBeNull()
  })
})
