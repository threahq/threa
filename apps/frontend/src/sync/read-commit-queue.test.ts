import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  ReadCommitQueue,
  READ_COMMIT_DEBOUNCE_MS,
  READ_COMMIT_MAX_RETRIES,
  READ_COMMIT_PARKED_RETRY_MS,
  READ_COMMIT_RETRY_MS,
} from "./read-commit-queue"

const commit = vi.fn<(streamId: string, lastEventId: string, opts: { partial: boolean }) => Promise<void>>()

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
    commit.mockResolvedValue(undefined)
    queue = makeQueue()
  })

  afterEach(() => {
    queue.dispose()
    vi.useRealTimers()
  })

  it("debounces a report and commits the newest mark (coalescing per stream)", async () => {
    queue.report("stream_a", "event_1", true)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS - 100)
    queue.report("stream_a", "event_2", false)
    vi.advanceTimersByTime(READ_COMMIT_DEBOUNCE_MS - 100)
    expect(commit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(100)
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_2", { partial: false })
    await vi.runAllTimersAsync()
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

  it("resetCommitted forgets the record so a fresh open can re-commit the same mark", async () => {
    queue.report("stream_a", "event_1", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(queue.lastCommitted("stream_a")).not.toBeNull()
    queue.resetCommitted("stream_a")
    expect(queue.lastCommitted("stream_a")).toBeNull()
  })

  it("retries a rejected request and records it only after acknowledgement", async () => {
    commit.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined)
    queue.report("stream_a", "event_1", false)

    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(queue.lastCommitted("stream_a")).toBeNull()

    await vi.advanceTimersByTimeAsync(READ_COMMIT_RETRY_MS)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(queue.lastCommitted("stream_a")).toEqual({ lastEventId: "event_1", partial: false })
  })

  it("drops a failed older retry when a newer frontier is already queued", async () => {
    let rejectRead!: (error: Error) => void
    commit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (rejectRead = reject)))
    queue.report("stream_a", "event_1", true)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)

    queue.report("stream_a", "event_2", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    rejectRead(new Error("offline"))
    await Promise.resolve()
    await Promise.resolve()

    expect(commit.mock.calls).toEqual([
      ["stream_a", "event_1", { partial: true }],
      ["stream_a", "event_2", { partial: false }],
    ])
    await vi.advanceTimersByTimeAsync(READ_COMMIT_RETRY_MS * 2)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it("keeps probing at a bounded interval after the fast retries are exhausted", async () => {
    commit.mockRejectedValue(new Error("offline"))
    queue.report("stream_a", "event_1", false)
    await vi.advanceTimersByTimeAsync(
      READ_COMMIT_DEBOUNCE_MS + READ_COMMIT_RETRY_MS * (2 ** READ_COMMIT_MAX_RETRIES - 1)
    )
    expect(commit).toHaveBeenCalledTimes(READ_COMMIT_MAX_RETRIES + 1)

    commit.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_PARKED_RETRY_MS)

    expect(commit).toHaveBeenCalledTimes(READ_COMMIT_MAX_RETRIES + 2)
    expect(queue.lastCommitted("stream_a")).toEqual({ lastEventId: "event_1", partial: false })
  })

  it("wakes an exhausted failed mark when the app regains focus", async () => {
    commit.mockRejectedValue(new Error("offline"))
    queue.report("stream_a", "event_1", false)
    await vi.advanceTimersByTimeAsync(
      READ_COMMIT_DEBOUNCE_MS + READ_COMMIT_RETRY_MS * (2 ** READ_COMMIT_MAX_RETRIES - 1)
    )
    expect(commit).toHaveBeenCalledTimes(READ_COMMIT_MAX_RETRIES + 1)
    expect(queue.lastCommitted("stream_a")).toBeNull()

    commit.mockResolvedValue(undefined)
    window.dispatchEvent(new Event("focus"))
    await Promise.resolve()

    expect(commit).toHaveBeenCalledTimes(READ_COMMIT_MAX_RETRIES + 2)
    expect(queue.lastCommitted("stream_a")).toEqual({ lastEventId: "event_1", partial: false })
  })

  it("serializes explicit unread behind an in-flight read and blocks reports until the pointer changes", async () => {
    let releaseRead!: () => void
    commit.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseRead = resolve)))
    queue.report("stream_a", "event_3", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)

    const order: string[] = []
    const unread = queue.runExplicitUnread("stream_a", "event_3", async () => {
      order.push("unread")
      return "event_1"
    })
    queue.report("stream_a", "event_4", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(order).toEqual([])

    releaseRead()
    await unread
    expect(order).toEqual(["unread"])

    queue.report("stream_a", "event_4", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledTimes(1)

    queue.observeReadPointer("stream_a", "event_1")
    queue.report("stream_a", "event_4", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it("serializes overlapping explicit unread requests so the newer request cannot complete first", async () => {
    const starts: string[] = []
    let resolveFirst!: (eventId: string | null) => void
    let resolveSecond!: (eventId: string | null) => void
    const first = queue.runExplicitUnread("stream_a", "event_5", () => {
      starts.push("first")
      return new Promise<string | null>((resolve) => (resolveFirst = resolve))
    })
    await Promise.resolve()

    const second = queue.runExplicitUnread("stream_a", "event_5", () => {
      starts.push("second")
      return new Promise<string | null>((resolve) => (resolveSecond = resolve))
    })
    await Promise.resolve()
    expect(starts).toEqual(["first"])

    resolveFirst("event_3")
    await first
    await Promise.resolve()
    expect(starts).toEqual(["first", "second"])

    resolveSecond("event_1")
    await second
    queue.observeReadPointer("stream_a", "event_1")
    queue.report("stream_a", "event_6", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_6", { partial: false })
  })

  it("releases unread against the locally reconciled pointer when a newer frontier superseded the response", async () => {
    let resolveUnread!: (eventId: string | null) => void
    const unread = queue.runExplicitUnread(
      "stream_a",
      "event_3",
      () => new Promise<string | null>((resolve) => (resolveUnread = resolve))
    )
    await Promise.resolve()

    queue.observeReadPointer("stream_a", "event_4")
    resolveUnread("event_4")
    await unread

    queue.report("stream_a", "event_5", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_5", { partial: false })
  })

  it("releases unread when a newer pointer arrives after the operation resolves", async () => {
    const unread = queue.runExplicitUnread("stream_a", "event_5", async () => "event_3")
    await unread

    queue.report("stream_a", "event_6", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).not.toHaveBeenCalled()

    queue.observeReadPointer("stream_a", "event_4")
    queue.report("stream_a", "event_6", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)

    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_6", { partial: false })
  })

  it("releases unread when its expected pointer was observed before a later cross-device read", async () => {
    let resolveUnread!: (eventId: string | null) => void
    const unread = queue.runExplicitUnread(
      "stream_a",
      "event_3",
      () => new Promise<string | null>((resolve) => (resolveUnread = resolve))
    )
    await Promise.resolve()

    queue.observeReadPointer("stream_a", "event_1")
    queue.observeReadPointer("stream_a", "event_4")
    resolveUnread("event_1")
    await unread

    queue.report("stream_a", "event_5", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    expect(commit).toHaveBeenCalledExactlyOnceWith("stream_a", "event_5", { partial: false })
  })

  it("drains a newer mark queued behind an in-flight request during disposal", async () => {
    let releaseFirst!: () => void
    commit.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseFirst = resolve)))
    queue.report("stream_a", "event_1", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)
    queue.report("stream_a", "event_2", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)

    queue.dispose()
    releaseFirst()
    await Promise.resolve()
    await Promise.resolve()

    expect(commit.mock.calls).toEqual([
      ["stream_a", "event_1", { partial: false }],
      ["stream_a", "event_2", { partial: false }],
    ])
  })

  it("retries an in-flight request that fails after disposal", async () => {
    let rejectFirst!: (error: Error) => void
    commit
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (rejectFirst = reject)))
      .mockResolvedValueOnce(undefined)
    queue.report("stream_a", "event_1", false)
    await vi.advanceTimersByTimeAsync(READ_COMMIT_DEBOUNCE_MS)

    queue.dispose()
    rejectFirst(new Error("offline"))
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(READ_COMMIT_RETRY_MS)

    expect(commit).toHaveBeenCalledTimes(2)
    expect(queue.lastCommitted("stream_a")).toEqual({ lastEventId: "event_1", partial: false })
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
