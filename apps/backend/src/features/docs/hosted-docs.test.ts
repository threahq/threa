import { describe, test, expect } from "bun:test"
import { StreamTypes } from "@threahq/types"
import { docFirstLine, docHostFor } from "./hosted-docs"

describe("docFirstLine", () => {
  test.each([
    ["the first non-blank line, trimmed", "\n   \n  ## Q4 tracker  \nsecond line", "## Q4 tracker"],
    ["the raw markdown of the line", "- [ ] Ship **docs**", "- [ ] Ship **docs**"],
    ["null for a blank section", " \n\t\n", null],
    ["null for a doc with no section", undefined, null],
    ["the line capped at 120 characters", "x".repeat(130), `${"x".repeat(120)}…`],
    ["the line before a hard break, without its backslash", "AWS row\\\nsecond line", "AWS row"],
    ["an escaped backslash ending the line as one backslash", "C:\\\\\nnext", "C:\\"],
  ])("returns %s", (_name, markdown, expected) => {
    expect(docFirstLine(markdown)).toBe(expected)
  })
})

describe("docHostFor", () => {
  const channel = { id: "stream_channel", rootStreamId: null, e2eEnabled: false }
  const thread = { id: "stream_thread", rootStreamId: "stream_channel", e2eEnabled: false }

  test.each([
    ["a channel hosts its own docs", channel, StreamTypes.CHANNEL, "stream_channel"],
    ["a thread works on its root's docs", thread, StreamTypes.CHANNEL, "stream_channel"],
    ["a scratchpad hosts its own docs", { ...channel, id: "stream_pad" }, StreamTypes.SCRATCHPAD, "stream_pad"],
    ["a sealed stream has no doc host", { ...channel, e2eEnabled: true }, StreamTypes.SCRATCHPAD, null],
    ["an aside cannot host docs", { ...channel, id: "stream_aside" }, StreamTypes.ASIDE, null],
    ["a thread with no root found has no doc host", thread, null, null],
  ])("%s", (_name, stream, rootType, expected) => {
    expect(docHostFor(stream, rootType)).toBe(expected)
  })
})
