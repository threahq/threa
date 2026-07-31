import { describe, expect, it } from "bun:test"
import { createMessageSchema } from "./handlers"

const base = { streamId: "stream_1", contentJson: { type: "doc" as const, content: [] } }
const trace = {
  horizonStreamId: "stream_host",
  openedAt: "2026-07-30T10:00:00.000Z",
  openedAtSequence: 41,
  sentAtSequence: 47,
  resumedDraft: false,
}

function parse(composeTrace: unknown) {
  return createMessageSchema.safeParse({ ...base, composeTrace })
}

describe("composeTrace validation", () => {
  it("accepts a well-formed trace", () => {
    expect(parse(trace).success).toBe(true)
  })

  it("accepts null sequences (nothing synced yet)", () => {
    expect(parse({ ...trace, openedAtSequence: null, sentAtSequence: null }).success).toBe(true)
  })

  it("accepts a send with no trace at all", () => {
    expect(createMessageSchema.safeParse(base).success).toBe(true)
  })

  it.each([
    ["a negative sequence", { ...trace, openedAtSequence: -1 }],
    ["a fractional sequence", { ...trace, sentAtSequence: 1.5 }],
    ["a non-ISO openedAt", { ...trace, openedAt: "yesterday" }],
    ["a missing openedAt", { openedAtSequence: 1, sentAtSequence: 2, resumedDraft: false }],
    ["a missing resumedDraft", { openedAt: trace.openedAt, openedAtSequence: 1, sentAtSequence: 2 }],
    // The sequences are per-stream: without the stream they were read from the
    // numbers cannot be interpreted at all, so an absent/blank id is a reject.
    ["a missing horizonStreamId", { ...trace, horizonStreamId: undefined }],
    ["a blank horizonStreamId", { ...trace, horizonStreamId: "" }],
    ["an unknown key", { ...trace, dwellMs: 4000 }],
    ["a non-object trace", "2026-07-30T10:00:00.000Z"],
  ])("rejects %s", (_label, composeTrace) => {
    expect(parse(composeTrace).success).toBe(false)
  })

  it("accepts a trace on the E2E variant", () => {
    expect(
      createMessageSchema.safeParse({
        streamId: "stream_1",
        ciphertext: "Y2lwaGVydGV4dA==",
        envelope: { v: 2, keyGeneration: 0, iv: "aXY=", aad: "msg_1" },
        e2eVersion: 2,
        composeTrace: trace,
      }).success
    ).toBe(true)
  })
})
