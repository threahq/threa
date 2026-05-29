import { describe, expect, test, mock } from "bun:test"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { GeneralResearcher, type GeneralResearchInput } from "./general-researcher"

/**
 * Minimal AI stub: the GeneralResearcher only touches `getLanguageModel`,
 * `parseModel`, and (via the inner AgentRuntime) `generateTextWithTools`.
 * `respond` is the scripted sequence of model turns the inner loop will see.
 */
function buildAI(respond: () => unknown): AI {
  return {
    getLanguageModel: mock(() => ({}) as never),
    parseModel: mock(() => ({
      modelId: "claude-sonnet-4.6",
      modelProvider: "anthropic",
      modelName: "claude-sonnet-4.6",
    })),
    generateTextWithTools: mock(async () => respond()),
  } as unknown as AI
}

const configResolver = {
  resolve: mock(async () => ({
    modelId: "openrouter:anthropic/claude-sonnet-4.6",
    temperature: 0.3,
    maxIterations: 3,
  })),
} as unknown as ConfigResolver

function baseInput(overrides: Partial<GeneralResearchInput> = {}): GeneralResearchInput {
  return {
    workspaceId: "ws_1",
    query: "What changed in the auth flow and is the PR merged?",
    tools: [],
    costContext: { workspaceId: "ws_1", userId: "user_1", sessionId: "sess_1", origin: "user" },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 120_000,
    onSubstep: () => {},
    ...overrides,
  }
}

describe("GeneralResearcher", () => {
  test("captures a text-only final answer as the brief (status ok)", async () => {
    const ai = buildAI(() => ({
      text: "Auth now uses WorkOS sessions; PR #412 is merged.",
      toolCalls: [],
      response: {
        messages: [{ role: "assistant", content: "Auth now uses WorkOS sessions; PR #412 is merged." }],
      },
    }))
    const researcher = new GeneralResearcher({ ai, configResolver })

    const result = await researcher.research(baseInput())

    expect(result.partial).toBeUndefined()
    expect(result.brief).toBe("Auth now uses WorkOS sessions; PR #412 is merged.")
  })

  test("captures a send_message tool call as the brief", async () => {
    const ai = buildAI(() => ({
      text: "",
      toolCalls: [{ toolCallId: "tc_1", toolName: "send_message", input: { content: "Brief delivered via tool." } }],
      response: { messages: [{ role: "assistant", content: "" }] },
    }))
    const researcher = new GeneralResearcher({ ai, configResolver })

    const result = await researcher.research(baseInput())

    expect(result.partial).toBeUndefined()
    expect(result.brief).toBe("Brief delivered via tool.")
  })

  test("returns a partial result with user_abort when the signal is already aborted", async () => {
    const generate = mock(async () => ({ text: "", toolCalls: [], response: { messages: [] } }))
    const ai = { ...buildAI(() => ({})), generateTextWithTools: generate } as unknown as AI
    const researcher = new GeneralResearcher({ ai, configResolver })

    const controller = new AbortController()
    controller.abort()

    const result = await researcher.research(baseInput({ signal: controller.signal }))

    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe("user_abort")
    // The loop aborts before any model call when the deadline/stop is already tripped.
    expect(generate).not.toHaveBeenCalled()
  })

  test("returns a partial result with timeout when the deadline has already passed", async () => {
    const researcher = new GeneralResearcher({ ai: buildAI(() => ({})), configResolver })

    const result = await researcher.research(baseInput({ deadlineAt: Date.now() - 1 }))

    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe("timeout")
  })

  test("forwards substeps emitted by inner tool progress to onSubstep", async () => {
    const substeps: string[] = []
    // Two turns: first issues a (real) web_search-shaped tool call, then finishes.
    // The tool itself is stubbed below so we control its progress + output.
    let turn = 0
    const ai = buildAI(() => {
      turn += 1
      if (turn === 1) {
        return {
          text: "",
          toolCalls: [{ toolCallId: "tc_1", toolName: "web_search", input: { query: "auth flow" } }],
          response: { messages: [{ role: "assistant", content: "" }] },
        }
      }
      return {
        text: "Done.",
        toolCalls: [],
        response: { messages: [{ role: "assistant", content: "Done." }] },
      }
    })
    const researcher = new GeneralResearcher({ ai, configResolver })

    const webSearchTool = {
      name: "web_search",
      config: {
        name: "web_search",
        description: "stub",
        inputSchema: { parse: (v: unknown) => v } as never,
        execute: async (_input: unknown, opts: { onProgress?: (s: string) => void }) => {
          opts.onProgress?.("inner: found 3 results")
          return {
            output: JSON.stringify({ results: 3 }),
            sources: [{ type: "web" as const, title: "Result", url: "https://example.com/r" }],
          }
        },
        trace: {
          stepType: "web_search" as const,
          formatContent: () => "{}",
          extractSources: () => [{ type: "web" as const, title: "Result", url: "https://example.com/r" }],
        },
      },
    }

    const result = await researcher.research(baseInput({ tools: [webSearchTool], onSubstep: (t) => substeps.push(t) }))

    expect(result.partial).toBeUndefined()
    // tool:start ("Searching the web…") + tool:progress ("inner: found 3 results")
    expect(substeps.some((s) => s.includes("Searching the web"))).toBe(true)
    expect(substeps).toContain("inner: found 3 results")
    // Source surfaced from the completed tool call.
    expect(result.sources).toEqual([{ type: "web", title: "Result", url: "https://example.com/r" }])
  })
})
