import { describe, expect, it, mock, spyOn } from "bun:test"
import { logger } from "../../lib/logger"
import { IncrementalVoiceEngine } from "./incremental-engine"
import { IncrementalPolishCoordinator } from "./incremental-coordinator"

const contentJson = { type: "doc", content: [{ type: "paragraph" }] }
const success = async (input: { rawTranscript: string }) => ({
  status: "success" as const,
  markdown: input.rawTranscript.toUpperCase(),
  contentJson,
})
const context = { level: "opinionated" as const, workspaceId: "ws", userId: "user", sessionId: "session" }

function acceptedPredecessor(engine: IncrementalVoiceEngine) {
  for (const value of ["one", "two", "three", "four"]) engine.appendFinal(value)
  const window = engine.activeWindow!
  engine.registerOperation({
    operationId: "prior",
    sources: [{ chunkId: window.chunkId, throughRevision: window.latestRevision }],
    resultChunkId: window.chunkId,
    markdown: "Prior",
    contentJson,
    rawMarkdown: engine.raw(window),
    rawContentJson: contentJson,
  })
  engine.acknowledge("prior", "applied")
  return window
}

describe("IncrementalPolishCoordinator", () => {
  it("formats one bounded source and accepts only after applied ack", async () => {
    const engine = new IncrementalVoiceEngine()
    const window = engine.appendFinal("hello")[0]!.window
    const appliedSources: unknown[] = []
    const apply = mock(async (operation: { sources: unknown[] }) => {
      appliedSources.push(operation.sources)
      return "applied" as const
    })
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: success,
      applyOperation: apply,
      context,
    })
    expect(await coordinator.run(window, "live", false)).toMatchObject({ status: "applied", widened: false })
    expect(appliedSources[0]).toEqual([{ chunkId: window.chunkId, throughRevision: window.latestRevision }])
    expect(engine.exactCurrentAccepted()?.markdown).toBe("HELLO")
  })

  it("logs replacement acknowledgement metadata without transcript or Markdown", async () => {
    const transcript = "PRIVATE_ACK_TRANSCRIPT_SENTINEL"
    const logs: unknown[][] = []
    const info = spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args)
      return logger
    })
    try {
      const engine = new IncrementalVoiceEngine()
      const window = engine.appendFinal(transcript)[0]!.window
      const coordinator = new IncrementalPolishCoordinator({
        engine,
        polishTranscript: success,
        applyOperation: async () => "locked",
        context,
      })
      expect(await coordinator.run(window, "final", true)).toMatchObject({ status: "rejected", ackStatus: "locked" })
      expect(logs).toContainEqual([
        expect.objectContaining({
          protocolVersion: 4,
          authoritative: true,
          scope: "tail",
          widened: false,
          sourceWindowCount: 1,
          ackStatus: "locked",
          applied: false,
        }),
        "Voice transcript replacement acknowledgement completed",
      ])
      expect(JSON.stringify(logs)).not.toContain(transcript)
      expect(JSON.stringify(logs)).not.toContain(transcript.toUpperCase())
    } finally {
      info.mockRestore()
    }
  })

  it("separates same-window revision guidance from a read-only predecessor", async () => {
    const engine = new IncrementalVoiceEngine()
    const first = engine.appendFinal("first")[0]!.window
    const inputs: Array<{
      previousAcceptedMarkdown?: string
      readOnlyPredecessorMarkdown?: string
      targetMode?: string
    }> = []
    const polish = mock(
      async (input: {
        rawTranscript: string
        previousAcceptedMarkdown?: string
        readOnlyPredecessorMarkdown?: string
        targetMode?: string
      }) => {
        inputs.push(input)
        return success(input)
      }
    )
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: polish,
      applyOperation: async () => "applied",
      context,
    })
    await coordinator.run(first, "live", false)
    const sameWindow = engine.appendFinal("second")[0]!.window
    await coordinator.run(sameWindow, "live", false)
    expect(inputs[1]).toMatchObject({ previousAcceptedMarkdown: "FIRST", targetMode: "tail" })
    expect(inputs[1]?.readOnlyPredecessorMarkdown).toBeUndefined()

    const secondEngine = new IncrementalVoiceEngine()
    acceptedPredecessor(secondEngine)
    const later = secondEngine.appendFinal("independent")[0]!.window
    const laterInputs: typeof inputs = []
    const laterCoordinator = new IncrementalPolishCoordinator({
      engine: secondEngine,
      polishTranscript: async (input) => {
        laterInputs.push(input)
        return success(input)
      },
      decideBoundaryScope: async () => ({ status: "success", scope: "tail" }),
      applyOperation: async () => "applied",
      context,
    })
    await laterCoordinator.run(later, "live", false)
    expect(laterInputs[0]).toMatchObject({ readOnlyPredecessorMarkdown: "Prior", targetMode: "tail" })
    expect(laterInputs[0]?.previousAcceptedMarkdown).toBeUndefined()
  })

  it("runs scope and speculative tail concurrently then widens exactly two contiguous sources", async () => {
    const engine = new IncrementalVoiceEngine()
    const predecessor = acceptedPredecessor(engine)
    const window = engine.appendFinal("continue")[0]!.window
    const calls: string[] = []
    const polish = mock(async (input: { rawTranscript: string }) => {
      calls.push(input.rawTranscript)
      return success(input)
    })
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: polish,
      decideBoundaryScope: async () => ({ status: "success", scope: "widen_previous" }),
      applyOperation: async () => "applied",
      context,
    })
    expect(await coordinator.run(window, "final", true)).toMatchObject({ status: "applied", widened: true })
    expect(calls).toEqual(["continue", `${engine.raw(predecessor)} continue`])
    expect(engine.windows).toHaveLength(1)
    expect(engine.activeWindow!.rawCharCount).toBe(Array.from(`${engine.raw(predecessor)} continue`).length)
  })

  it("preserves raw on scope refusal and clears rejected or timed-out pending operations", async () => {
    const engine = new IncrementalVoiceEngine()
    acceptedPredecessor(engine)
    const window = engine.appendFinal("tail")[0]!.window
    const preserve = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: success,
      decideBoundaryScope: async () => ({ status: "success", scope: "preserve_raw" }),
      applyOperation: async () => "applied",
      context,
    })
    expect(await preserve.run(window, "live", false)).toEqual({ status: "preserve_raw", scope: "preserve_raw" })
    expect(window.accepted).toBeUndefined()

    const timeout = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: success,
      applyOperation: async () => "timeout",
      context,
    })
    expect(await timeout.run(window, "final", true)).toMatchObject({ status: "rejected", ackStatus: "timeout" })
    expect(window.accepted).toBeUndefined()
  })

  it("honors pre-abort and includes or omits same-window accepted context", async () => {
    const engine = new IncrementalVoiceEngine()
    const window = engine.appendFinal("first")[0]!.window
    const inputs: Array<{ previousAcceptedMarkdown?: string }> = []
    const polish = async (input: { rawTranscript: string; previousAcceptedMarkdown?: string }) => {
      inputs.push(input)
      return success(input)
    }
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: polish,
      applyOperation: async () => "applied",
      context,
    })
    await coordinator.run(window, "live", false)
    engine.appendFinal(" second")
    await coordinator.run(window, "live", false)
    const without = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: polish,
      includePreviousAccepted: false,
      applyOperation: async () => "applied",
      context,
    })
    engine.appendFinal(" third")
    await without.run(window, "live", false)
    expect(inputs.map((input) => input.previousAcceptedMarkdown)).toEqual([undefined, "FIRST", undefined])

    const controller = new AbortController()
    controller.abort()
    expect(await coordinator.run(window, "final", true, controller.signal)).toEqual({ status: "canceled" })
  })

  it("registers the immutable revision captured before model work", async () => {
    const engine = new IncrementalVoiceEngine()
    const window = engine.appendFinal("first")[0]!.window
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: async (input) => {
        await blocked
        return success(input)
      },
      applyOperation: async () => "applied",
      context,
    })
    const running = coordinator.run(window, "live", false)
    engine.appendFinal("second")
    release()
    expect(await running).toEqual({ status: "canceled" })
    expect(window.accepted).toBeUndefined()
  })

  it("keeps an applied acknowledgement when cancellation races after emission", async () => {
    const engine = new IncrementalVoiceEngine()
    const window = engine.appendFinal("first")[0]!.window
    const controller = new AbortController()
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: success,
      applyOperation: async () => {
        controller.abort()
        return "applied"
      },
      context,
    })
    expect(await coordinator.run(window, "live", false, controller.signal)).toMatchObject({ status: "applied" })
    expect(window.accepted?.markdown).toBe("FIRST")
  })

  it("does not recursively widen a previously collapsed two-window span", async () => {
    const engine = new IncrementalVoiceEngine()
    const predecessor = acceptedPredecessor(engine)
    const second = engine.appendFinal("second")[0]!.window
    const widen = () =>
      new IncrementalPolishCoordinator({
        engine,
        polishTranscript: success,
        decideBoundaryScope: async () => ({ status: "success" as const, scope: "widen_previous" as const }),
        applyOperation: async () => "applied" as const,
        context,
      })
    expect(await widen().run(second, "live", false)).toMatchObject({ status: "applied", widened: true })
    for (const value of ["a", "b", "c", "d"]) engine.appendFinal(value)
    expect(engine.immediateAcceptedPredecessor(engine.activeWindow)?.logicalSpanCount).toBe(2)
    expect(await widen().run(engine.activeWindow!, "live", false)).toEqual({
      status: "preserve_raw",
      scope: "preserve_raw",
    })
    expect(engine.windows.some((window) => window.chunkId === predecessor.chunkId)).toBe(false)
  })

  it("reuses an exact acknowledged current result without a final formatter call", async () => {
    const engine = new IncrementalVoiceEngine()
    const window = engine.appendFinal("done")[0]!.window
    const polish = mock(success)
    const coordinator = new IncrementalPolishCoordinator({
      engine,
      polishTranscript: polish,
      applyOperation: async () => "applied",
      context,
    })
    await coordinator.run(window, "live", false)
    polish.mockClear()
    expect(await coordinator.run(window, "final", true)).toEqual({ status: "reused" })
    expect(polish).not.toHaveBeenCalled()
  })
})
