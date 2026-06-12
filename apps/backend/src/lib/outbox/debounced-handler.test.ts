import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as cursorLockModule from "@threa/backend-common"
import type { ProcessResult } from "@threa/backend-common"
import { OutboxRepository } from "./repository"
import type { OutboxEvent } from "./repository"
import { DebouncedOutboxHandler } from "./debounced-handler"

// Replace CursorLock.run with a fake that invokes the processor once with
// cursor 0 and no in-flight ids. This exercises the real
// processEvents/processEvent path without a database. The returned promise
// resolves with the ProcessResult when the batch completes, so tests await
// actual completion instead of sleeping through real debounce timers.
function mockCursorLock(): Promise<ProcessResult> {
  let resolve: (result: ProcessResult) => void
  const completed = new Promise<ProcessResult>((r) => {
    resolve = r
  })
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(() => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      resolve(await processor(0n, []))
    }),
  }))
  return completed
}

function makeEvent(id: bigint, eventType: string): OutboxEvent {
  return { id, eventType, payload: {}, createdAt: new Date() } as unknown as OutboxEvent
}

// Minimal concrete subclass: records the events it was handed and optionally
// throws on a designated id, so we can observe per-event dispatch and the
// partial-progress error path. Zero debounce so handle() fires on the next
// tick — the tests await batch completion, not wall-clock time.
class TestHandler extends DebouncedOutboxHandler {
  readonly handled: bigint[] = []

  constructor(private readonly throwOnId?: bigint) {
    super({} as any, { listenerId: "test-handler", debounceMs: 0, maxWaitMs: 0 })
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (this.throwOnId !== undefined && event.id === this.throwOnId) {
      throw new Error(`boom on ${event.id}`)
    }
    this.handled.push(event.id)
  }
}

describe("DebouncedOutboxHandler", () => {
  afterEach(() => {
    mock.restore()
  })

  it("processes every event in the batch and reports them as processed", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      makeEvent(1n, "message:created"),
      makeEvent(2n, "message:created"),
      makeEvent(3n, "reaction:added"),
    ])
    const completed = mockCursorLock()

    const handler = new TestHandler()
    handler.handle()
    const result = await completed

    expect(handler.handled).toEqual([1n, 2n, 3n])
    expect(result).toEqual({ status: "processed", processedIds: [1n, 2n, 3n] })
  })

  it("returns an error carrying the ids processed before the throw (partial progress)", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      makeEvent(1n, "message:created"),
      makeEvent(2n, "message:created"),
      makeEvent(3n, "message:created"),
    ])
    const completed = mockCursorLock()

    // Event 1 and 2 succeed, event 3 throws — the batch must report the two it
    // already handled so the cursor advances over them and only 3 is retried.
    const handler = new TestHandler(3n)
    handler.handle()
    const result = await completed

    expect(handler.handled).toEqual([1n, 2n])
    expect(result.status).toBe("error")
    expect(result).toMatchObject({ status: "error", processedIds: [1n, 2n] })
    if (result.status === "error") {
      expect(result.error.message).toBe("boom on 3")
    }
  })

  it("returns an error with no processedIds when the first event throws", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([
      makeEvent(1n, "message:created"),
      makeEvent(2n, "message:created"),
    ])
    const completed = mockCursorLock()

    const handler = new TestHandler(1n)
    handler.handle()
    const result = await completed

    expect(handler.handled).toEqual([])
    expect(result.status).toBe("error")
    if (result.status === "error") {
      expect(result.processedIds).toBeUndefined()
      expect(result.error.message).toBe("boom on 1")
    }
  })

  it("reports no_events for an empty batch without invoking processEvent", async () => {
    spyOn(OutboxRepository, "fetchAfterId").mockResolvedValue([])
    const completed = mockCursorLock()

    const handler = new TestHandler()
    handler.handle()
    const result = await completed

    expect(handler.handled).toEqual([])
    expect(result).toEqual({ status: "no_events" })
  })
})
