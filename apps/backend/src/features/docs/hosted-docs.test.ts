import { describe, test, expect } from "bun:test"
import { StreamTypes } from "@threahq/types"
import type { Querier } from "../../db"
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

describe("docHostFor early returns", () => {
  const db: Querier = {
    query: async () => {
      throw new Error("Early doc host resolution must not query the database")
    },
  }
  const root = { id: "stream_root", type: StreamTypes.SCRATCHPAD, rootStreamId: null, e2eEnabled: false }
  const thread = { ...root, id: "stream_thread", type: StreamTypes.THREAD, rootStreamId: root.id }

  test.each([
    ["use a rootless scratchpad as its own doc host", root, StreamTypes.SCRATCHPAD, root.id],
    [
      "use a rootless channel as its own doc host",
      { ...root, type: StreamTypes.CHANNEL },
      StreamTypes.CHANNEL,
      root.id,
    ],
    ["reject a sealed root", { ...root, e2eEnabled: true }, StreamTypes.SCRATCHPAD, null],
    ["reject a sealed thread", { ...thread, e2eEnabled: true }, StreamTypes.CHANNEL, null],
    ["reject a missing root type", thread, null, null],
    ["reject an aside root", { ...root, type: StreamTypes.ASIDE }, StreamTypes.ASIDE, null],
    ["reject a system root", { ...root, type: StreamTypes.SYSTEM }, StreamTypes.SYSTEM, null],
  ])("should %s", async (_name, stream, rootType, expected) => {
    expect(await docHostFor(db, "ws_test", stream, rootType)).toBe(expected)
  })
})
