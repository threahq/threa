import { describe, expect, test, mock } from "bun:test"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { defaultConfigResolver } from "../../../lib/ai/static-config-resolver"
import { GENERAL_RESEARCH_MODEL_ID } from "./config"
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
    parseModel: mock((id: string) => ({ modelId: id, modelProvider: "openrouter", modelName: id })),
    generateTextWithTools: mock(async () => ({
      text: "Auth now uses WorkOS sessions; PR #412 is merged.",
      toolCalls: [],
      response: {
        messages: [{ role: "assistant", content: "Auth now uses WorkOS sessions; PR #412 is merged." }],
      },
    })),
  } as unknown as AI
}

/** `configModelId` mirrors the resolver: production registers none, an override sets one. */
function buildResearcher(configModelId?: string) {
  const ai = buildAI()
  const resolve = mock(async () => ({
    ...(configModelId ? { modelId: configModelId } : {}),
    temperature: 0.3,
    maxIterations: 3,
  }))
  const configResolver = { resolve } as unknown as ConfigResolver
  return { ai, resolve, researcher: new GeneralResearcher({ ai, configResolver }) }
}

function researchInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws_1",
    query: "What changed in the auth flow and is the PR merged?",
    tools: [],
    costContext: { workspaceId: "ws_1", userId: "user_1", sessionId: "sess_1", origin: "user" as const },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 120_000,
    onSubstep: () => {},
    ...overrides,
  }
}

describe("GeneralResearcher (backend adapter)", () => {
  test("resolves config and delegates to the shared loop", async () => {
    const { ai, resolve, researcher } = buildResearcher()

    const result = await researcher.research(researchInput({ modelId: "openrouter:openai/gpt-5.6-terra" }))

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(ai.getLanguageModel).toHaveBeenCalledWith("openrouter:openai/gpt-5.6-terra")
    expect(result.partial).toBeUndefined()
    expect(result.brief).toBe("Auth now uses WorkOS sessions; PR #412 is merged.")
  })

  describe("model precedence", () => {
    test("a resolved config model wins over the caller's turn model", async () => {
      // An eval's componentOverrides / a -m permutation must isolate the
      // researcher from whichever model the turn under test is running.
      const { ai, researcher } = buildResearcher("openrouter:anthropic/claude-sonnet-5")

      await researcher.research(researchInput({ modelId: "openrouter:openai/gpt-5.6-terra" }))

      expect(ai.getLanguageModel).toHaveBeenCalledWith("openrouter:anthropic/claude-sonnet-5")
      expect(ai.getLanguageModel).not.toHaveBeenCalledWith("openrouter:openai/gpt-5.6-terra")
    })

    test("the caller's turn model wins over the fallback constant", async () => {
      const { ai, researcher } = buildResearcher()

      await researcher.research(researchInput({ modelId: "openrouter:openai/gpt-5.6-terra" }))

      expect(ai.getLanguageModel).toHaveBeenCalledWith("openrouter:openai/gpt-5.6-terra")
      expect(ai.getLanguageModel).not.toHaveBeenCalledWith(GENERAL_RESEARCH_MODEL_ID)
    })

    test("falls back to the constant when neither is set", async () => {
      const { ai, researcher } = buildResearcher()

      await researcher.research(researchInput())

      expect(ai.getLanguageModel).toHaveBeenCalledWith(GENERAL_RESEARCH_MODEL_ID)
    })
  })

  test("production registers no researcher model, so the turn's model reaches the loop", async () => {
    const ai = buildAI()
    const researcher = new GeneralResearcher({ ai, configResolver: defaultConfigResolver })

    await researcher.research(researchInput({ modelId: "openrouter:openai/gpt-5.6-terra" }))

    expect(ai.getLanguageModel).toHaveBeenCalledWith("openrouter:openai/gpt-5.6-terra")
  })
})
