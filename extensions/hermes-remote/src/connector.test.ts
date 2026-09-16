import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFileConversationStore } from "./connector"

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "hermes-conversations-")), "conversations.json")
}

describe("createFileConversationStore", () => {
  test("round-trips generations and forked conversations", () => {
    const path = tempStorePath()
    const store = createFileConversationStore(path)
    store.save({ generations: { stream_root: 3 }, forked: ["stream_thread"] })

    expect({ loaded: store.load(), file: JSON.parse(readFileSync(path, "utf8")) }).toEqual({
      loaded: { generations: { stream_root: 3 }, forked: ["stream_thread"] },
      file: { generations: { stream_root: 3 }, forked: ["stream_thread"] },
    })
  })

  test("a missing file is an empty state", () => {
    expect(createFileConversationStore(tempStorePath()).load()).toEqual({ generations: {}, forked: [] })
  })
})
