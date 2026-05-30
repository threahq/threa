import { describe, expect, test, mock } from "bun:test"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { GeneralResearcher } from "./general-researcher"

/**
 * The bounded research LOOP is covered in the shared package
 * (`@threa/agent-runtime` `runGeneralResearch`). This suite covers only the
 * backend adapter's job: resolve the overridable config + model off the full
 * `AI`/`ConfigResolver` and forward them to the loop. We script a one-turn
 * text-only answer and assert the resolved values flowed through.
 */
function buildAI(): AI {
  return {
    getLanguageModel: mock(() => ({}) as never),
    parseModel: mock(() => ({
      modelId: "claude-sonnet-4.6",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4.6",
    })),
    generateTextWithTools: mock(async () => ({
      text: "Auth now uses WorkOS sessions; PR #412 is merged.",
      toolCalls: [],
      response: {
        messages: [{ role: "assistant", content: "Auth now uses WorkOS sessions; PR #412 is merged." }],
      },
    })),
  } as unknown as AI
}

describe("GeneralResearcher (backend adapter)", () => {
  test("resolves config + model and delegates to the shared loop", async () => {
    const ai = buildAI()
    const resolve = mock(async () => ({
      modelId: "openrouter:anthropic/claude-sonnet-4.6",
      temperature: 0.3,
      maxIterations: 3,
    }))
    const configResolver = { resolve } as unknown as ConfigResolver

    const researcher = new GeneralResearcher({ ai, configResolver })
    const result = await researcher.research({
      workspaceId: "ws_1",
      query: "What changed in the auth flow and is the PR merged?",
      tools: [],
      costContext: { workspaceId: "ws_1", userId: "user_1", sessionId: "sess_1", origin: "user" },
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 120_000,
      onSubstep: () => {},
    })

    expect(resolve).toHaveBeenCalledTimes(1)
    // Model resolved off the resolved config id and handed to the loop.
    expect(ai.getLanguageModel).toHaveBeenCalledWith("openrouter:anthropic/claude-sonnet-4.6")
    expect(result.partial).toBeUndefined()
    expect(result.brief).toBe("Auth now uses WorkOS sessions; PR #412 is merged.")
  })
})
