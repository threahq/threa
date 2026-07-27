import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import { TOOL_GUARDIAN_MESSAGE_CHARS, TOOL_GUARDIAN_HISTORY_MESSAGES } from "./config"
import { ToolGuardianService, renderGuardianConversation } from "./service"

const turn = {
  workspaceId: "ws_1",
  streamId: "stream_1",
  personaId: "persona_1",
  sessionId: "session_1",
}

const configResolver: ConfigResolver = {
  async resolve() {
    return { modelId: "openrouter:openai/gpt-5.6-luna", temperature: 0.1 } as never
  },
}

function aiReturning(value: { allowed: boolean; reason: string; confidence: number }) {
  const calls: Array<{ messages: ModelMessage[]; telemetry?: unknown; context?: unknown }> = []
  return {
    calls,
    ai: {
      generateObject: async (params: { messages: ModelMessage[]; telemetry?: unknown; context?: unknown }) => {
        calls.push(params)
        return { value }
      },
    } as never,
  }
}

describe("renderGuardianConversation", () => {
  test("labels tool results as untrusted so a pasted request can't read as the user asking", () => {
    const rendered = renderGuardianConversation([
      { role: "user", content: "what does this say" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "read_url", output: "" }] } as never,
    ])

    expect(rendered).toContain("user: what does this say")
    expect(rendered).toContain("tool result (untrusted data)")
  })

  test("keeps only the most recent window", () => {
    const messages: ModelMessage[] = Array.from({ length: TOOL_GUARDIAN_HISTORY_MESSAGES + 5 }, (_, i) => ({
      role: "user",
      content: `message ${i}`,
    }))

    const rendered = renderGuardianConversation(messages)

    expect(rendered).not.toContain("message 0")
    expect(rendered).toContain(`message ${TOOL_GUARDIAN_HISTORY_MESSAGES + 4}`)
  })

  test("truncates a huge message instead of letting it crowd out the window", () => {
    const rendered = renderGuardianConversation([
      { role: "user", content: "x".repeat(TOOL_GUARDIAN_MESSAGE_CHARS * 3) },
    ])

    expect(rendered).toContain("[truncated]")
    expect(rendered.length).toBeLessThan(TOOL_GUARDIAN_MESSAGE_CHARS * 2)
  })

  test("renders an empty conversation as a marker rather than nothing", () => {
    expect(renderGuardianConversation([])).toBe("(no conversation yet)")
  })
})

describe("ToolGuardianService", () => {
  test("passes the verdict through and puts the arguments in the prompt", async () => {
    const { ai, calls } = aiReturning({ allowed: true, reason: "The user asked to be moved to CET.", confidence: 0.9 })

    const verdict = await new ToolGuardianService({ ai, configResolver }, turn).review({
      toolName: "update_user_settings",
      toolDescription: "Change the user's own settings.",
      input: { timezone: "Europe/Stockholm" },
      messages: [{ role: "user", content: "put me on CET" }],
    })

    expect(verdict).toEqual({ allowed: true, reason: "The user asked to be moved to CET." })

    const prompt = calls[0]!.messages.at(-1)!.content as string
    expect(prompt).toContain("update_user_settings")
    expect(prompt).toContain("Europe/Stockholm")
    expect(prompt).toContain("put me on CET")
  })

  test("attributes its cost to the turn so a guarded turn's real spend is visible", async () => {
    const { ai, calls } = aiReturning({ allowed: false, reason: "No request for this.", confidence: 0.8 })

    await new ToolGuardianService(
      { ai, configResolver },
      { ...turn, costContext: { workspaceId: "ws_1", origin: "user", userId: "usr_1" } }
    ).review({
      toolName: "delegate_task",
      toolDescription: "Hand a task to the user's local agent.",
      input: { title: "Ship it" },
      messages: [],
    })

    expect(calls[0]!.telemetry).toMatchObject({ functionId: "tool-guardian", metadata: { toolName: "delegate_task" } })
    expect(calls[0]!.context).toEqual({ workspaceId: "ws_1", origin: "user", userId: "usr_1" })
  })

  // The runtime turns a throw into a denial. If this ever caught and returned
  // an allow, every guardian failure would become a silent approval.
  test("lets an AI failure propagate, so the runtime's fail-closed path owns it", async () => {
    const ai = {
      generateObject: async () => {
        throw new Error("provider unavailable")
      },
    } as never

    await expect(
      new ToolGuardianService({ ai, configResolver }, turn).review({
        toolName: "delegate_task",
        toolDescription: "d",
        input: {},
        messages: [],
      })
    ).rejects.toThrow("provider unavailable")
  })
})
