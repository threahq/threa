import { describe, expect, test, mock } from "bun:test"
import { runGeneralResearch, type GeneralResearchRunInput, type RunGeneralResearchDeps } from "./general-researcher"
import type { AgentRuntimeAI } from "../runtime/agent-runtime"

/**
 * Minimal AI stub: the loop only calls `generateTextWithTools`. `respond` is the
 * scripted sequence of model turns the inner loop will see.
 */
function buildDeps(respond: () => unknown): RunGeneralResearchDeps {
  const ai: AgentRuntimeAI = {
    generateTextWithTools: mock(async () => respond() as never),
  }
  return {
    ai,
    model: {} as never,
    modelString: "openrouter:anthropic/claude-sonnet-4.6",
    temperature: 0.3,
    maxIterations: 3,
  }
}

function baseInput(overrides: Partial<GeneralResearchRunInput> = {}): GeneralResearchRunInput {
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

describe("runGeneralResearch", () => {
  test("captures a text-only final answer as the brief (status ok)", async () => {
    const deps = buildDeps(() => ({
      text: "Auth now uses WorkOS sessions; PR #412 is merged.",
      toolCalls: [],
      response: {
        messages: [{ role: "assistant", content: "Auth now uses WorkOS sessions; PR #412 is merged." }],
      },
    }))

    const result = await runGeneralResearch(deps, baseInput())

    expect(result.partial).toBeUndefined()
    expect(result.brief).toBe("Auth now uses WorkOS sessions; PR #412 is merged.")
  })

  test("captures a send_message tool call as the brief", async () => {
    const deps = buildDeps(() => ({
      text: "",
      toolCalls: [{ toolCallId: "tc_1", toolName: "send_message", input: { content: "Brief delivered via tool." } }],
      response: { messages: [{ role: "assistant", content: "" }] },
    }))

    const result = await runGeneralResearch(deps, baseInput())

    expect(result.partial).toBeUndefined()
    expect(result.brief).toBe("Brief delivered via tool.")
  })

  test("returns a partial result with user_abort when the signal is already aborted", async () => {
    const generate = mock(async () => ({ text: "", toolCalls: [], response: { messages: [] } }))
    const deps = { ...buildDeps(() => ({})), ai: { generateTextWithTools: generate } as AgentRuntimeAI }

    const controller = new AbortController()
    controller.abort()

    const result = await runGeneralResearch(deps, baseInput({ signal: controller.signal }))

    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe("user_abort")
    // The loop aborts before any model call when the deadline/stop is already tripped.
    expect(generate).not.toHaveBeenCalled()
  })

  test("returns a partial result with timeout when the deadline has already passed", async () => {
    const deps = buildDeps(() => ({}))

    const result = await runGeneralResearch(deps, baseInput({ deadlineAt: Date.now() - 1 }))

    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe("timeout")
  })

  test("forwards substeps emitted by inner tool progress to onSubstep", async () => {
    const substeps: string[] = []
    // Two turns: first issues a (real) web_search-shaped tool call, then finishes.
    // The tool itself is stubbed below so we control its progress + output.
    let turn = 0
    const deps = buildDeps(() => {
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

    const result = await runGeneralResearch(
      deps,
      baseInput({ tools: [webSearchTool], onSubstep: (t) => substeps.push(t) })
    )

    expect(result.partial).toBeUndefined()
    // tool:start ("Searching the web…") + tool:progress ("inner: found 3 results")
    expect(substeps.some((s) => s.includes("Searching the web"))).toBe(true)
    expect(substeps).toContain("inner: found 3 results")
    // Source surfaced from the completed tool call.
    expect(result.sources).toEqual([{ type: "web", title: "Result", url: "https://example.com/r" }])
  })
})
