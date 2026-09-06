import { describe, expect, test } from "bun:test"
import type { AI } from "@threahq/agent-runtime"
import type { EvalContext } from "../../framework/types"
import { runVoicePolishTask } from "./suite"

function context(
  generateText: (options: any) => Promise<any>,
  model = "openrouter:openai/gpt-5.4-mini",
  onGenerateObject?: (options: any) => void
): EvalContext {
  return {
    ai: {
      generateText,
      generateObject: async (options: any) => {
        onGenerateObject?.(options)
        return { value: { scope: "tail" }, usage: {} }
      },
    } as unknown as AI,
    workspaceId: "ws_eval",
    userId: "usr_eval",
    permutation: { model, temperature: 0 },
    componentOverrides: { "voice-polish": { model, temperature: 0 } },
  } as unknown as EvalContext
}

describe("voice polish eval production entrypoint", () => {
  test("injects model config and forwards only immediately preceding success", async () => {
    const calls: any[] = []
    const values = ["First accepted.", "", "Third accepted."]
    const ctx = context(async (options) => {
      calls.push(options)
      const value = values[calls.length - 1]
      return { value, finishReason: value ? "stop" : "length", usage: {} }
    })
    const result = await runVoicePolishTask(
      { steps: [{ rawTranscript: "first" }, { rawTranscript: "second" }, { rawTranscript: "third" }] },
      ctx
    )

    expect(calls.map((call) => call.model)).toEqual(Array(3).fill("openrouter:openai/gpt-5.4-mini"))
    expect(calls[0].messages[1].content).not.toContain("Previously accepted polish")
    expect(calls[1].messages[1].content).toContain("First accepted.")
    expect(calls[2].messages[1].content).toContain("First accepted.")
    expect(result.steps.map((step) => step.outcome.status)).toEqual(["success", "invalid_output", "success"])
  })

  test("captures composer context once and ignores later-step context", async () => {
    const calls: any[] = []
    const ctx = context(
      async (options) => {
        calls.push(options)
        return { value: "Accepted.", finishReason: "stop", usage: {} }
      },
      undefined,
      (options) => calls.push(options)
    )
    await runVoicePolishTask(
      {
        steps: [
          { rawTranscript: "one", draftBefore: "START_CONTEXT", draftAfter: "START_AFTER" },
          { rawTranscript: "two", draftBefore: "LATER_SECRET", draftAfter: "LATER_AFTER" },
        ],
      },
      ctx
    )
    const prompts = calls.map((call) => call.messages[1].content)
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts.every((prompt) => prompt.includes("START_CONTEXT") && prompt.includes("START_AFTER"))).toBe(true)
    expect(prompts.some((prompt) => prompt.includes("LATER_SECRET") || prompt.includes("LATER_AFTER"))).toBe(false)
  })

  test("does not treat dictated words already in the draft as context echo", async () => {
    const ctx = context(async () => ({ value: "Review access.", finishReason: "stop", usage: {} }))
    const result = await runVoicePolishTask(
      { steps: [{ rawTranscript: "review access", draftBefore: "- Review access\n- Existing context" }] },
      ctx
    )

    expect(result.steps[0]?.forbiddenContextTerms).toEqual(["Existing context"])
  })
})
