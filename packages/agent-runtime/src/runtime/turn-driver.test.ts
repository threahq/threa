import { describe, expect, it, mock } from "bun:test"
import { AgentToolNames } from "@threa/types"
import type { AgentEvent } from "./agent-events"
import { InProcessTurnDriver, TurnDeliveries, type TurnCommit, type TurnRequest } from "./turn-driver"

function plaintextRequest(overrides?: Partial<TurnRequest>): TurnRequest {
  return {
    delivery: TurnDeliveries.PLAINTEXT,
    model: {} as any,
    systemPrompt: "You are helpful.",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    ...overrides,
  }
}

describe("InProcessTurnDriver", () => {
  it("runs a plaintext turn through the loop and commits via the sink", async () => {
    const events: AgentEvent[] = []
    const commits: TurnCommit[] = []
    const driver = new InProcessTurnDriver({
      ai: {
        generateTextWithTools: async () => ({
          text: "",
          toolCalls: [
            { toolCallId: "tool_1", toolName: AgentToolNames.SEND_MESSAGE, input: { content: "Hello there" } },
          ],
          response: { messages: [{ role: "assistant", content: "Sending." } as any] },
        }),
      } as any,
    })

    const result = await driver.runTurn(plaintextRequest(), {
      commitMessage: async (commit) => {
        commits.push(commit)
        return { messageId: "msg_1", operation: "created" }
      },
      observers: [
        {
          handle: async (event) => {
            events.push(event)
          },
        },
      ],
    })

    expect(commits).toEqual([{ content: "Hello there", sources: [] }])
    expect(result.sentMessageIds).toEqual(["msg_1"])
    expect(result.messagesSent).toBe(1)
    expect(events.some((event) => event.type === "message:sent" && event.messageId === "msg_1")).toBe(true)
    expect(events.some((event) => event.type === "session:end" && event.messagesSent === 1)).toBe(true)
  })

  it("refuses a non-plaintext delivery before any model call", async () => {
    const generateTextWithTools = mock(async () => {
      throw new Error("must not be called")
    })
    const commitMessage = mock(async () => ({ messageId: "msg_never" }))
    const driver = new InProcessTurnDriver({ ai: { generateTextWithTools } as any })

    expect(driver.delivery).toBe(TurnDeliveries.PLAINTEXT)
    await expect(
      driver.runTurn(plaintextRequest({ delivery: TurnDeliveries.SEALED }), { commitMessage })
    ).rejects.toThrow('serves "plaintext" turns')
    expect(generateTextWithTools).not.toHaveBeenCalled()
    expect(commitMessage).not.toHaveBeenCalled()
  })

  it("forwards the sink's control edges to the loop", async () => {
    const generateTextWithTools = mock(async () => {
      throw new Error("must not be called")
    })
    const driver = new InProcessTurnDriver({ ai: { generateTextWithTools } as any })

    await expect(
      driver.runTurn(plaintextRequest(), {
        commitMessage: async () => ({ messageId: "msg_never" }),
        shouldAbort: async () => "session superseded",
      })
    ).rejects.toThrow("Agent session aborted: session superseded")
    expect(generateTextWithTools).not.toHaveBeenCalled()
  })
})
