import { describe, expect, it } from "vitest"
import { streamHasMembers } from "./use-stream-members"

describe("streamHasMembers", () => {
  it.each([
    ["channel", null, true],
    ["scratchpad", null, true],
    ["dm", null, true],
    ["thread", "stream_root", true],
    ["doc", null, true],
    ["doc", "stream_host", false],
    ["aside", null, false],
    ["system", null, false],
  ])("%s with parent %s → %s", (type, parentStreamId, expected) => {
    expect(streamHasMembers({ type, parentStreamId })).toBe(expected)
  })

  it("is false without a stream", () => {
    expect(streamHasMembers(null)).toBe(false)
  })
})
