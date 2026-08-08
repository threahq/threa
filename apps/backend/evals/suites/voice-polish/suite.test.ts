import { describe, expect, test } from "bun:test"
import type { AI } from "@threa/agent-runtime"
import type { EvalContext } from "../../framework/types"
import { runVoicePolishTask } from "./suite"

function context(generateText: (options: any) => Promise<any>, model = "openrouter:openai/gpt-5.4-mini"): EvalContext {
  return {
    ai: { generateText } as unknown as AI,
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

  test("does not treat dictated words already in the draft as context echo", async () => {
    const ctx = context(async () => ({ value: "Review access.", finishReason: "stop", usage: {} }))
    const result = await runVoicePolishTask(
      { steps: [{ rawTranscript: "review access", draftBefore: "- Review access\n- Existing context" }] },
      ctx
    )

    expect(result.steps[0]?.forbiddenContextTerms).toEqual(["Existing context"])
  })
})
