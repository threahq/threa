import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ReadCommitQueue, READ_COMMIT_DEBOUNCE_MS } from "./read-commit-queue"

const commit = vi.fn()

function makeQueue() {
  return new ReadCommitQueue({
    workspaceId: "ws_1",
    commitRef: { current: (streamId, lastEventId, opts) => commit(streamId, lastEventId, opts) },
  })
}

describe("ReadCommitQueue", () => {
  let queue: ReadCommitQueue

  beforeEach(() => {
    vi.useFakeTimers()
    commit.mockReset()
    queue = makeQueue()
  })

  afterEach(() => {
    queue.dispose()
    vi.useRealTimers()
  })

  it("debounces a report and commits the newest mark (coalescing per stream)", () => {
    queue.report("stream_a", "event_1", true)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS - 100)
    queue.report("stream_a", "event_2", false)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS - 100)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_2", { partial: false })
    expect(queue.lastCommitted("stream_a")).toEqual({ lastEventId: "event_2", partial: false })
  })

  it("debounces independently per stream", () => {
    queue.report("stream_a", "event_a", false)
    queue.report("stream_b", "event_b", true)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledWith("stream_a", "event_a", { partial: false })
    expect(commit).toHaveBeenCalledWith("stream_b", "event_b", { partial: true })
  })

  it("cancel drops the pending mark without committing or recording it", () => {
    queue.report("stream_a", "event_1", false)
    queue.cancel("stream_a")
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS * 2)
    expect(commit).not.toHaveBeenCalled()
    // Not committed → a later identical report is NOT deduped away.
    expect(queue.lastCommitted("stream_a")).toBeNull()
  })

  it("flush commits the pending mark immediately", () => {
    queue.report("stream_a", "event_1", true)
    queue.flush("stream_a")
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_1", { partial: true })
    // The timer died with the flush — no double commit.
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS * 2)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it("pagehide flushes everything pending (leaving the page skips effect cleanup)", () => {
    queue.report("stream_a", "event_a", false)
    queue.report("stream_b", "event_b", true)
    window.dispatchEvent(new Event("pagehide"))
    expect(commit).toHaveBeenCalledWith("stream_a", "event_a", { partial: false })
    expect(commit).toHaveBeenCalledWith("stream_b", "event_b", { partial: true })
  })

  it("resetCommitted forgets the record so a fresh open can re-commit the same mark", () => {
    queue.report("stream_a", "event_1", false)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS)
    expect(queue.lastCommitted("stream_a")).not.toBeNull()
    queue.resetCommitted("stream_a")
    expect(queue.lastCommitted("stream_a")).toBeNull()
  })

  it("dispose flushes pending marks (a microtask later — it can run in render) and refuses further reports", async () => {
    queue.report("stream_a", "event_1", false)
    queue.dispose()
    expect(queue.isDisposed).toBe(true)
    // The commit is deferred out of the caller's (possibly render-phase) stack.
    expect(commit).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_1", { partial: false })

    queue.report("stream_a", "event_2", false)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS * 2)
    expect(commit).toHaveBeenCalledTimes(1)

    // The pagehide listener is gone with the dispose.
    window.dispatchEvent(new Event("pagehide"))
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
