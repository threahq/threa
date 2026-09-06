import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { CompanionModes, StreamTypes } from "@threahq/types"
import type { ProcessResult } from "@threahq/backend-common"
import * as cursorLockModule from "@threahq/backend-common"
import { OutboxRepository } from "../../lib/outbox"
import { ContextBagPrecomputeHandler } from "./context-bag-precompute-handler"
import { ContextBagRepository } from "./context-bag"

function makeFakeCursorLock(onRun?: (result: ProcessResult) => void) {
  return () => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      const result = await processor(0n, [])
      onRun?.(result)
    }),
  })
}

function mockCursorLock(onRun?: (result: ProcessResult) => void) {
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(makeFakeCursorLock(onRun))
}

function makeScratchpad(overrides: Record<string, any> = {}): any {
  return {
    id: "stream_scratch",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    companionMode: CompanionModes.ON,
    companionPersonaId: "persona_ariadne",
    ...overrides,
  }
}

function mockStreamCreatedEvent(stream: any) {
  spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
    {
      id: 1n,
      eventType: "stream:created",
      payload: {
        workspaceId: stream.workspaceId,
        streamId: stream.id,
        stream,
      },
      createdAt: new Date("2026-04-22T09:00:00.000Z"),
    } as any,
  ])
}

function createHandler() {
  mockCursorLock()
  const jobQueue = { send: mock(async () => "queue_1") } as any
  const handler = new ContextBagPrecomputeHandler({} as any, jobQueue)
  return { handler, jobQueue }
}

async function waitForDebounce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300))
}

describe("ContextBagPrecomputeHandler", () => {
  afterEach(() => {
    mock.restore()
  })

  it("dispatches a CONTEXT_BAG_PRECOMPUTE job when a scratchpad has a bag attached", async () => {
    const stream = makeScratchpad()
    mockStreamCreatedEvent(stream)
    spyOn(ContextBagRepository, "findByStream").mockResolvedValue({
      id: "sca_1",
      workspaceId: "ws_1",
      streamId: stream.id,
      intent: "discuss-thread",
      refs: [{ kind: "thread", streamId: "stream_source" }],
      lastRendered: null,
      createdBy: "usr_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).toHaveBeenCalledTimes(1)
    expect(jobQueue.send).toHaveBeenCalledWith("context_bag.precompute", {
      workspaceId: "ws_1",
      streamId: "stream_scratch",
      bagId: "sca_1",
    })
  })

  it("skips dispatch when scratchpad has no bag attached (normal companion flow)", async () => {
    const stream = makeScratchpad()
    mockStreamCreatedEvent(stream)
    spyOn(ContextBagRepository, "findByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  it("skips dispatch when the stream is not a scratchpad", async () => {
    // Channels and threads never carry a context bag; the handler must not
    // even touch the bag repository for them.
    const channel = makeScratchpad({ type: StreamTypes.CHANNEL })
    mockStreamCreatedEvent(channel)
    const findByStream = spyOn(ContextBagRepository, "findByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
    expect(findByStream).not.toHaveBeenCalled()
  })

  it("skips dispatch when companion mode is off", async () => {
    // Bag-free scratchpads with companion off stay silent — the
    // pre-compute handler only fires for companion-on + bag-present.
    const stream = makeScratchpad({ companionMode: CompanionModes.OFF })
    mockStreamCreatedEvent(stream)
    const findByStream = spyOn(ContextBagRepository, "findByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
    expect(findByStream).not.toHaveBeenCalled()
  })

  it("ignores unrelated event types", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      {
        id: 1n,
        eventType: "message:created",
        payload: {},
        createdAt: new Date(),
      } as any,
    ])
    const findByStream = spyOn(ContextBagRepository, "findByStream").mockResolvedValue(null)

    const { handler, jobQueue } = createHandler()
    handler.handle()
    await waitForDebounce()

    expect(jobQueue.send).not.toHaveBeenCalled()
    expect(findByStream).not.toHaveBeenCalled()
  })
})
