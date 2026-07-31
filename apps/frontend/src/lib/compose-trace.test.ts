import { describe, it, expect, beforeEach, vi } from "vitest"
import { db } from "@/db"
import { ComposeTraceRecorder } from "./compose-trace"

// fake-indexeddb is loaded in test setup, so the sequence reads below run
// against a real Dexie store — the point of the optimistic-exclusion case.
const streamId = "stream_1"

function persistedEvent(id: string, sequence: number, status?: "pending") {
  return {
    id,
    streamId,
    workspaceId: "ws_1",
    sequence: String(sequence),
    eventType: "message_created" as const,
    payload: { messageId: id, contentMarkdown: "hi" },
    actorId: "usr_1",
    actorType: "user" as const,
    createdAt: new Date().toISOString(),
    _sequenceNum: sequence,
    _cachedAt: Date.now(),
    ...(status ? { _status: status } : {}),
  }
}

describe("ComposeTraceRecorder", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  it("stamps the horizon once per session, not on every focus", async () => {
    const readSequence = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue("100")
    const recorder = new ComposeTraceRecorder(readSequence)

    await recorder.open("scope_a", streamId, false)
    readSequence.mockResolvedValue("140")
    await recorder.open("scope_a", streamId, true)
    await recorder.open("scope_a", streamId, true)

    const trace = await recorder.take()
    expect({ openedAtSequence: trace?.openedAtSequence, sentAtSequence: trace?.sentAtSequence }).toEqual({
      openedAtSequence: 100,
      sentAtSequence: 140,
    })
    // Three focuses + one send read the stream exactly twice.
    expect(readSequence).toHaveBeenCalledTimes(2)
  })

  it("records a resumed draft, and reports it only for the session that saw it", async () => {
    const recorder = new ComposeTraceRecorder(async () => "1")

    await recorder.open("scope_a", streamId, true)
    expect((await recorder.take())?.resumedDraft).toBe(true)

    await recorder.open("scope_a", streamId, false)
    expect((await recorder.take())?.resumedDraft).toBe(false)
  })

  it("yields nothing when the author never focused the composer", async () => {
    const recorder = new ComposeTraceRecorder(async () => "1")
    expect(await recorder.take()).toBeUndefined()
  })

  it("ends the session on send, so the next focus opens a fresh one", async () => {
    const recorder = new ComposeTraceRecorder(async () => "1")

    await recorder.open("scope_a", streamId, false)
    const first = await recorder.take()
    expect(await recorder.take()).toBeUndefined()

    await recorder.open("scope_a", streamId, false)
    const second = await recorder.take()
    expect(second?.openedAt).not.toBe(undefined)
    expect(first?.openedAt).not.toBe(undefined)
  })

  it("drops a session when the composer's scope changes", async () => {
    const recorder = new ComposeTraceRecorder(async () => "1")

    await recorder.open("scope_a", streamId, true)
    recorder.reset()
    expect(await recorder.take()).toBeUndefined()
  })

  it("replaces the session when focus lands in a different scope", async () => {
    const recorder = new ComposeTraceRecorder(async () => "1")

    await recorder.open("scope_a", streamId, true)
    await recorder.open("scope_b", streamId, false)

    expect((await recorder.take())?.resumedDraft).toBe(false)
  })

  it("measures the horizon against synced events only, never the author's own optimistic rows", async () => {
    await db.events.bulkPut([persistedEvent("evt_real", 200), persistedEvent("temp_mine", 9_999_999, "pending")])
    const recorder = new ComposeTraceRecorder()

    await recorder.open("scope_a", streamId, false)
    const trace = await recorder.take()

    expect({ openedAtSequence: trace?.openedAtSequence, sentAtSequence: trace?.sentAtSequence }).toEqual({
      openedAtSequence: 200,
      sentAtSequence: 200,
    })
  })

  it("carries the stream the sequences were measured against, not the send's destination", async () => {
    const recorder = new ComposeTraceRecorder(async () => "5")

    await recorder.open("scope_a", "stream_host", false)

    expect((await recorder.take())?.horizonStreamId).toBe("stream_host")
  })

  it("replaces the session when the same scope's horizon stream changes", async () => {
    const readSequence = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue("1")
    const recorder = new ComposeTraceRecorder(readSequence)

    await recorder.open("scope_a", "stream_a", true)
    await recorder.open("scope_a", "stream_b", false)
    const trace = await recorder.take()

    expect({ horizonStreamId: trace?.horizonStreamId, resumedDraft: trace?.resumedDraft }).toEqual({
      horizonStreamId: "stream_b",
      resumedDraft: false,
    })
    // Both sequence reads for the closing session hit its own stream.
    expect(readSequence.mock.calls.at(-1)).toEqual(["stream_b"])
  })

  it("reports a null horizon when nothing has synced for the stream", async () => {
    const recorder = new ComposeTraceRecorder()

    await recorder.open("scope_a", "stream_empty", false)
    const trace = await recorder.take()

    expect({ openedAtSequence: trace?.openedAtSequence, sentAtSequence: trace?.sentAtSequence }).toEqual({
      openedAtSequence: null,
      sentAtSequence: null,
    })
  })
})
