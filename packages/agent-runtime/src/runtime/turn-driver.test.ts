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

  it("uses the repaired body consistently for commit, trace, and result", async () => {
    const events: AgentEvent[] = []
    const commits: TurnCommit[] = []
    const repairMessageContent = mock(async (content: string) => `${content} repaired`)
    const driver = new InProcessTurnDriver({ ai: commitOnceAI("Draft") })

    const result = await driver.runTurn(plaintextRequest(), {
      repairMessageContent,
      commitMessage: async (commit) => {
        commits.push(commit)
        return { messageId: "msg_1" }
      },
      observers: [{ handle: async (event) => void events.push(event) }],
    })

    expect(repairMessageContent).toHaveBeenCalledTimes(1)
    expect(commits).toEqual([{ content: "Draft repaired", sources: [] }])
    expect(result.sentContents).toEqual(["Draft repaired"])
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message:sent", messageId: "msg_1", content: "Draft repaired" })
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "session:end", lastContent: "Draft repaired" }))
  })

  it("surfaces repair failures without committing the draft", async () => {
    const commits: TurnCommit[] = []
    const driver = new InProcessTurnDriver({ ai: commitOnceAI("Draft") })

    await expect(
      driver.runTurn(plaintextRequest(), {
        repairMessageContent: async () => {
          throw new Error("reference lookup failed")
        },
        commitMessage: async (commit) => {
          commits.push(commit)
          return { messageId: "msg_1" }
        },
      })
    ).rejects.toThrow("reference lookup failed")
    expect(commits).toEqual([])
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

describe("turn-level output guard", () => {
  function scriptedAI(contents: string[], seen?: Array<Array<{ role: string; content: string }>>) {
    let call = 0
    return {
      generateTextWithTools: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        seen?.push(messages)
        const content = contents[call++]!
        return {
          text: "",
          toolCalls: [{ toolCallId: `tool_${call}`, toolName: AgentToolNames.SEND_MESSAGE, input: { content } }],
          response: { messages: [{ role: "assistant", content: "Sending." } as any] },
        }
      },
    } as any
  }

  it("re-prompts a send_message draft carrying a leaked pointer tag and commits only the clean retry", async () => {
    const commits: TurnCommit[] = []
    const driver = new InProcessTurnDriver({
      ai: scriptedAI(["[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Hi", "Hi"]),
    })

    const result = await driver.runTurn(plaintextRequest(), {
      commitMessage: async (commit) => {
        commits.push(commit)
        return { messageId: "msg_1", operation: "created" }
      },
    })

    expect(commits).toEqual([{ content: "Hi", sources: [] }])
    expect(result.messagesSent).toBe(1)
  })

  it("re-prompts a draft whose body is tool-call markup", async () => {
    const commits: TurnCommit[] = []
    const driver = new InProcessTurnDriver({
      ai: scriptedAI([
        '<invoke name="workspace_research">\n<parameter name="query">preview bugs</parameter>\n</invoke>',
        "Looking into the preview bugs now.",
      ]),
    })

    const result = await driver.runTurn(plaintextRequest(), {
      commitMessage: async (commit) => {
        commits.push(commit)
        return { messageId: "msg_1", operation: "created" }
      },
    })

    expect(commits).toEqual([{ content: "Looking into the preview bugs now.", sources: [] }])
    expect(result.messagesSent).toBe(1)
  })

  it("falls through to the request's own validator, and the built-in reason wins", async () => {
    const prompts: Array<Array<{ role: string; content: string }>> = []
    const commits: TurnCommit[] = []
    const driver = new InProcessTurnDriver({
      ai: scriptedAI(
        ["[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Hi", "An action summary.", "Hi there."],
        prompts
      ),
    })

    const result = await driver.runTurn(
      plaintextRequest({
        validateFinalResponse: async (content: string) =>
          content === "An action summary." ? "Send the requested reply content, not an action summary." : null,
      }),
      {
        commitMessage: async (commit) => {
          commits.push(commit)
          return { messageId: "msg_1", operation: "created" }
        },
      }
    )

    expect(commits).toEqual([{ content: "Hi there.", sources: [] }])
    expect(result.messagesSent).toBe(1)
    expect(prompts[1]!.at(-1)!.content).toContain("input-only")
    expect(prompts[2]!.at(-1)!.content).toContain("not an action summary")
  })

  it("re-prompts with every pending draft when one part trips the guard", async () => {
    const prompts: Array<Array<{ role: string; content: string }>> = []
    const commits: TurnCommit[] = []
    let call = 0
    const driver = new InProcessTurnDriver({
      ai: {
        generateTextWithTools: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
          prompts.push(messages)
          call++
          const contents =
            call === 1
              ? ["Part one is clean.", "[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Part two."]
              : ["Part one is clean.", "Part two."]
          return {
            text: "",
            toolCalls: contents.map((content, i) => ({
              toolCallId: `tool_${call}_${i}`,
              toolName: AgentToolNames.SEND_MESSAGE,
              input: { content },
            })),
            response: { messages: [{ role: "assistant", content: "Sending." } as any] },
          }
        },
      } as any,
    })

    const result = await driver.runTurn(plaintextRequest(), {
      commitMessage: async (commit) => {
        commits.push(commit)
        return { messageId: `msg_${commits.length}`, operation: "created" }
      },
    })

    const revisePrompt = prompts[1]!.at(-1)!.content
    expect(revisePrompt).toContain("Part one is clean.")
    expect(revisePrompt).toContain("resend each one")
    expect(commits.map((c) => c.content)).toEqual(["Part one is clean.", "Part two."])
    expect(result.messagesSent).toBe(2)
  })

  it("gives up after the invalid-draft cap when every draft is rejected", async () => {
    const commits: TurnCommit[] = []
    let calls = 0
    const driver = new InProcessTurnDriver({
      ai: {
        generateTextWithTools: async () => {
          calls++
          return {
            text: "",
            toolCalls: [
              {
                toolCallId: `tool_${calls}`,
                toolName: AgentToolNames.SEND_MESSAGE,
                input: { content: "[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Hi" },
              },
            ],
            response: { messages: [{ role: "assistant", content: "Sending." } as any] },
          }
        },
      } as any,
    })

    await expect(
      driver.runTurn(plaintextRequest(), {
        commitMessage: async (commit) => {
          commits.push(commit)
          return { messageId: "msg_1", operation: "created" }
        },
      })
    ).rejects.toThrow("Agent loop stopped after repeated invalid final drafts without sending a message")

    expect(commits).toEqual([])
    expect(calls).toBe(3)
  })

  it("gives up on the cap even when every rejected draft differs", async () => {
    const commits: TurnCommit[] = []
    let calls = 0
    const driver = new InProcessTurnDriver({
      ai: {
        generateTextWithTools: async () => {
          calls++
          return {
            text: "",
            toolCalls: [
              {
                toolCallId: `tool_${calls}`,
                toolName: AgentToolNames.SEND_MESSAGE,
                input: {
                  content: `[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Draft ${calls}`,
                },
              },
            ],
            response: { messages: [{ role: "assistant", content: "Sending." } as any] },
          }
        },
      } as any,
    })

    await expect(
      driver.runTurn(plaintextRequest(), {
        commitMessage: async (commit) => {
          commits.push(commit)
          return { messageId: "msg_1", operation: "created" }
        },
      })
    ).rejects.toThrow("Agent loop stopped after repeated invalid final drafts without sending a message")

    expect(commits).toEqual([])
    expect(calls).toBe(3)
  })
  it("commits nothing when assistant preamble accompanies every rejected draft", async () => {
    const commits: TurnCommit[] = []
    let calls = 0
    const driver = new InProcessTurnDriver({
      ai: {
        generateTextWithTools: async () => {
          calls++
          return {
            text: "Let me answer that.",
            toolCalls: [
              {
                toolCallId: `tool_${calls}`,
                toolName: AgentToolNames.SEND_MESSAGE,
                input: {
                  content: `[msg:msg_01KYCCZYDQQNMR18Q5VRTGX0C4 author:persona_system_ariadne] Draft ${calls}`,
                },
              },
            ],
            response: { messages: [{ role: "assistant", content: "Let me answer that." } as any] },
          }
        },
      } as any,
    })

    await expect(
      driver.runTurn(plaintextRequest(), {
        commitMessage: async (commit) => {
          commits.push(commit)
          return { messageId: "msg_1", operation: "created" }
        },
      })
    ).rejects.toThrow("Agent loop stopped after repeated invalid final drafts without sending a message")

    expect(commits).toEqual([])
    expect(calls).toBe(3)
  })
})
