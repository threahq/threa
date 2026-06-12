import { describe, expect, it, mock } from "bun:test"
import { AgentToolNames } from "@threa/types"
import type { AgentEvent } from "./agent-events"
import {
  EnclaveTurnDriver,
  InProcessTurnDriver,
  TurnDeliveries,
  declaredUnsupported,
  isDeclaredUnsupported,
  type AnyTurnDriver,
  type DispatchedTurnDriver,
  type SynchronousTurnDriver,
  type TurnCommit,
  type TurnRequest,
} from "./turn-driver"

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

function sealedRequest(overrides?: Partial<TurnRequest>): TurnRequest {
  return { ...plaintextRequest(), delivery: TurnDeliveries.SEALED, ...overrides }
}

function commitOnceAI(content: string) {
  return {
    generateTextWithTools: async () => ({
      text: "",
      toolCalls: [{ toolCallId: "tool_1", toolName: AgentToolNames.SEND_MESSAGE, input: { content } }],
      response: { messages: [{ role: "assistant", content: "Sending." } as any] },
    }),
  } as any
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

describe("EnclaveTurnDriver", () => {
  it("runs a sealed turn through the SAME loop and commits via the sealing sink", async () => {
    const commits: TurnCommit[] = []
    const driver = new EnclaveTurnDriver({ ai: commitOnceAI("Sealed reply") })

    expect(driver.delivery).toBe(TurnDeliveries.SEALED)
    const result = await driver.runTurn(sealedRequest(), {
      commitMessage: async (commit) => {
        commits.push(commit)
        return { messageId: "msg_sealed_1" }
      },
      // The enclave declares interjection unsupported rather than omitting it; the
      // turn must still run and commit, proving the driver folds the sentinel to
      // "no provider" instead of handing it to the loop as an awareness object.
      newMessages: declaredUnsupported("encrypted scratchpads"),
    })

    expect(commits).toEqual([{ content: "Sealed reply", sources: [] }])
    expect(result.sentMessageIds).toEqual(["msg_sealed_1"])
    expect(result.messagesSent).toBe(1)
  })

  it("refuses a non-sealed delivery before any model call", async () => {
    const generateTextWithTools = mock(async () => {
      throw new Error("must not be called")
    })
    const commitMessage = mock(async () => ({ messageId: "msg_never" }))
    const driver = new EnclaveTurnDriver({ ai: { generateTextWithTools } as any })

    await expect(
      driver.runTurn(sealedRequest({ delivery: TurnDeliveries.PLAINTEXT }), { commitMessage })
    ).rejects.toThrow('serves "sealed" turns')
    expect(generateTextWithTools).not.toHaveBeenCalled()
    expect(commitMessage).not.toHaveBeenCalled()
  })
})

describe("turn driver families", () => {
  it("keeps the synchronous and dispatched families structurally distinct", () => {
    const driver = new InProcessTurnDriver({ ai: commitOnceAI("unused") })
    // `TurnDriver` aliases the synchronous contract, so today's call sites and
    // the union the dispatch layer routes over both accept the driver as-is.
    const synchronous: SynchronousTurnDriver = driver
    const anyDriver: AnyTurnDriver = driver
    // @ts-expect-error — a synchronous driver is not a dispatcher: it resolves the turn in one call instead of durably enqueueing it.
    const dispatched: DispatchedTurnDriver = driver
    expect([synchronous, anyDriver, dispatched]).toEqual([driver, driver, driver])
  })
})

describe("declaredUnsupported", () => {
  it("builds a renderable sentinel that narrows true and carries its reason", () => {
    const declared = declaredUnsupported("encrypted scratchpads")
    expect(declared).toEqual({ unsupported: true, reason: "encrypted scratchpads" })
    expect(isDeclaredUnsupported(declared)).toBe(true)
  })

  it("does not mistake a real awareness provider or nullish for the sentinel", () => {
    expect(isDeclaredUnsupported(undefined)).toBe(false)
    expect(isDeclaredUnsupported(null)).toBe(false)
    expect(isDeclaredUnsupported({ check: async () => [] })).toBe(false)
  })
})
