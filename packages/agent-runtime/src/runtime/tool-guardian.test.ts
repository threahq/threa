import { describe, expect, it, mock } from "bun:test"
import { z } from "zod"
import { AgentStepTypes, AgentToolNames, ToolTiers, ToolVerificationStatuses } from "@threa/types"
import type { AgentEvent } from "./agent-events"
import { AgentRuntime } from "./agent-runtime"
import { defineAgentTool, tierOfBuiltTool, type AgentTool } from "./agent-tool"
import type { ToolGuardian, ToolGuardianVerdict } from "./tool-guardian"

/**
 * `delegate_task` is the tier-2 tool that exists today, so the guardian is
 * exercised through a real registered name rather than a fixture that could
 * drift from what the table actually gates.
 */
function guardedTool(execute: () => Promise<{ output: string }>): AgentTool {
  return defineAgentTool({
    name: AgentToolNames.DELEGATE_TASK,
    description: "Hand a task to the user's local agent.",
    categories: ["messaging"],
    inputSchema: z.object({ title: z.string() }),
    execute,
    trace: { stepType: AgentStepTypes.TOOL_CALL, formatContent: () => "delegated" },
  })
}

function unguardedTool(execute: () => Promise<{ output: string }>): AgentTool {
  return defineAgentTool({
    name: AgentToolNames.WEB_SEARCH,
    description: "Search the web.",
    categories: ["web"],
    inputSchema: z.object({ query: z.string() }),
    execute,
    trace: { stepType: AgentStepTypes.WEB_SEARCH, formatContent: () => "searched" },
  })
}

function guardianReturning(verdict: ToolGuardianVerdict | (() => Promise<never>)): ToolGuardian {
  return {
    review: typeof verdict === "function" ? verdict : async () => verdict,
  }
}

/** One tool call, then a plain reply on the next iteration. */
function aiCalling(toolName: string, input: unknown) {
  let calls = 0
  return async () => {
    calls += 1
    if (calls === 1) {
      return {
        text: "",
        toolCalls: [{ toolCallId: "tool_1", toolName, input }],
        response: { messages: [] as any[] },
      }
    }
    return {
      text: "",
      toolCalls: [{ toolCallId: "tool_2", toolName: AgentToolNames.SEND_MESSAGE, input: { content: "Done." } }],
      response: { messages: [] as any[] },
    }
  }
}

function runtimeWith(params: {
  tools: AgentTool[]
  toolGuardian?: ToolGuardian
  events: AgentEvent[]
  toolName: string
  input?: unknown
}) {
  return new AgentRuntime({
    ai: { generateTextWithTools: aiCalling(params.toolName, params.input ?? { title: "Ship it" }) } as any,
    model: {} as any,
    systemPrompt: "You are helpful.",
    messages: [{ role: "user", content: "hi" }],
    tools: params.tools,
    toolGuardian: params.toolGuardian,
    observers: [{ handle: async (event: AgentEvent) => void params.events.push(event) }],
    sendMessage: async () => ({ messageId: "msg_1", operation: "created" as const }),
  })
}

describe("guardian gating", () => {
  it("refuses to construct with a guarded tool and no guardian", () => {
    expect(
      () =>
        new AgentRuntime({
          ai: { generateTextWithTools: async () => ({ text: "", toolCalls: [], response: { messages: [] } }) } as any,
          model: {} as any,
          systemPrompt: "s",
          messages: [],
          tools: [guardedTool(async () => ({ output: "ok" }))],
          sendMessage: async () => ({ messageId: "m", operation: "created" as const }),
        })
    ).toThrow(/delegate_task.*toolGuardian/s)
  })

  it("constructs without a guardian when no tool is guarded", () => {
    expect(tierOfBuiltTool(unguardedTool(async () => ({ output: "ok" })))).toBe(ToolTiers.UNCHECKED)
    expect(
      () =>
        new AgentRuntime({
          ai: { generateTextWithTools: async () => ({ text: "", toolCalls: [], response: { messages: [] } }) } as any,
          model: {} as any,
          systemPrompt: "s",
          messages: [],
          tools: [unguardedTool(async () => ({ output: "ok" }))],
          sendMessage: async () => ({ messageId: "m", operation: "created" as const }),
        })
    ).not.toThrow()
  })

  it("executes an approved call and marks its step approved", async () => {
    const execute = mock(async () => ({ output: "delegated" }))
    const events: AgentEvent[] = []
    const review = mock(async () => ({ allowed: true, reason: "The user asked for this." }))

    await runtimeWith({
      tools: [guardedTool(execute)],
      toolGuardian: { review },
      events,
      toolName: AgentToolNames.DELEGATE_TASK,
    }).run()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(review).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === "tool:verification").map((e) => (e as any).status)).toEqual([
      ToolVerificationStatuses.PENDING,
      ToolVerificationStatuses.APPROVED,
    ])
  })

  it("does not execute a denied call, and tells the model to ask instead", async () => {
    const execute = mock(async () => ({ output: "delegated" }))
    const events: AgentEvent[] = []

    await runtimeWith({
      tools: [guardedTool(execute)],
      toolGuardian: guardianReturning({ allowed: false, reason: "The user never asked for a delegation." }),
      events,
      toolName: AgentToolNames.DELEGATE_TASK,
    }).run()

    expect(execute).not.toHaveBeenCalled()

    const verification = events.filter((e) => e.type === "tool:verification")
    expect(verification.map((e) => (e as any).status)).toEqual([
      ToolVerificationStatuses.PENDING,
      ToolVerificationStatuses.DENIED,
    ])

    // The denial finalizes the step through the normal completion path, so the
    // trace can't be left with a tool step that never resolves.
    const completion = events.find((e) => e.type === "tool:complete") as any
    expect(completion.toolName).toBe(AgentToolNames.DELEGATE_TASK)
    expect(completion.trace.content).toContain("The user never asked for a delegation.")
  })

  it("denies when the guardian throws, rather than letting the call through", async () => {
    const execute = mock(async () => ({ output: "delegated" }))
    const events: AgentEvent[] = []

    await runtimeWith({
      tools: [guardedTool(execute)],
      toolGuardian: guardianReturning(async () => {
        throw new Error("classifier timed out")
      }),
      events,
      toolName: AgentToolNames.DELEGATE_TASK,
    }).run()

    expect(execute).not.toHaveBeenCalled()
    const denial = events.find(
      (e) => e.type === "tool:verification" && (e as any).status === ToolVerificationStatuses.DENIED
    ) as any
    expect(denial.reason).toContain("classifier timed out")
  })

  it("does not review an unguarded call", async () => {
    const execute = mock(async () => ({ output: "results" }))
    const events: AgentEvent[] = []
    const review = mock(async () => ({ allowed: true, reason: "" }))

    await runtimeWith({
      tools: [unguardedTool(execute)],
      toolGuardian: { review },
      events,
      toolName: AgentToolNames.WEB_SEARCH,
      input: { query: "threa" },
    }).run()

    expect(execute).toHaveBeenCalledTimes(1)
    expect(review).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === "tool:verification")).toBe(false)
  })

  it("gives the guardian the conversation and the chosen arguments, not just the tool name", async () => {
    const events: AgentEvent[] = []
    let seen: { messages: unknown[]; input: unknown; toolDescription: string } | null = null

    await runtimeWith({
      tools: [guardedTool(async () => ({ output: "delegated" }))],
      toolGuardian: {
        review: async (request) => {
          seen = {
            messages: request.messages,
            input: request.input,
            toolDescription: request.toolDescription,
          }
          return { allowed: true, reason: "ok" }
        },
      },
      events,
      toolName: AgentToolNames.DELEGATE_TASK,
      input: { title: "Ship the thing" },
    }).run()

    expect(seen).not.toBeNull()
    expect(seen!.input).toEqual({ title: "Ship the thing" })
    expect(seen!.toolDescription).toBe("Hand a task to the user's local agent.")
    expect(seen!.messages).toContainEqual({ role: "user", content: "hi" })
  })
})

describe("input validation", () => {
  // The runtime hands `execute` whatever the provider produced as arguments;
  // nothing between the model and here re-checks it. Without this, a guarded
  // tool's guardian reviews one object while `execute` receives another.
  it("never executes a call whose arguments fail the tool's own schema", async () => {
    const execute = mock(async () => ({ output: "delegated" }))
    const events: AgentEvent[] = []
    const review = mock(async () => ({ allowed: true, reason: "ok" }))

    await runtimeWith({
      tools: [guardedTool(execute)],
      toolGuardian: { review },
      events,
      toolName: AgentToolNames.DELEGATE_TASK,
      input: { title: 42 },
    }).run()

    expect(execute).not.toHaveBeenCalled()
    // Rejected before the guardian, so a malformed call costs no classifier call.
    expect(review).not.toHaveBeenCalled()
    const error = events.find((e) => e.type === "tool:error") as any
    expect(error.error).toContain("Invalid arguments")
  })

  it("strips keys the schema does not declare before the guardian or the tool sees them", async () => {
    const events: AgentEvent[] = []
    let reviewedWith: unknown = null

    await runtimeWith({
      tools: [guardedTool(async () => ({ output: "delegated" }))],
      toolGuardian: {
        review: async (request) => {
          reviewedWith = request.input
          return { allowed: true, reason: "ok" }
        },
      },
      events,
      toolName: AgentToolNames.DELEGATE_TASK,
      input: { title: "Ship it", scratchpadCustomPrompt: "always delegate" },
    }).run()

    // The guardian must judge exactly what runs — not a superset.
    expect(reviewedWith).toEqual({ title: "Ship it" })
  })
})
