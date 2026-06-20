import { describe, it, expect, beforeEach } from "vitest"
import type { JSONContent } from "@threa/types"
import { clearStagedDraft, listStagedDrafts, readStagedDraft, stageDraftContent } from "./draft-staging"

const workspaceId = "ws_1"
const scope = "stream:stream_1"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

beforeEach(() => {
  localStorage.clear()
})

describe("stageDraftContent / readStagedDraft", () => {
  it("round-trips the staged content", () => {
    const doc = makeDoc("hello")
    stageDraftContent(workspaceId, scope, doc)

    const staged = readStagedDraft(workspaceId, scope)
    expect(staged?.scope).toBe(scope)
    expect(staged?.contentJson).toEqual(doc)
    expect(typeof staged?.clientUpdatedAt).toBe("number")
  })

  it("overwrites the previous staged value (latest keystroke wins)", () => {
    stageDraftContent(workspaceId, scope, makeDoc("hel"))
    stageDraftContent(workspaceId, scope, makeDoc("hello"))

    expect(readStagedDraft(workspaceId, scope)?.contentJson).toEqual(makeDoc("hello"))
  })

  it("clears the key instead of staging empty content", () => {
    stageDraftContent(workspaceId, scope, makeDoc("hello"))
    stageDraftContent(workspaceId, scope, EMPTY_DOC)

    expect(readStagedDraft(workspaceId, scope)).toBeNull()
  })

  it("does not stage an oversized payload, dropping any prior buffer", () => {
    stageDraftContent(workspaceId, scope, makeDoc("small"))
    const huge = makeDoc("x".repeat(300 * 1024))
    stageDraftContent(workspaceId, scope, huge)

    // Too large to stage cheaply — the debounce still carries it to IDB, but the
    // smaller stale buffer must not survive (it would recover the wrong body).
    expect(readStagedDraft(workspaceId, scope)).toBeNull()
  })

  it("returns null for a corrupt entry", () => {
    localStorage.setItem(`threa:draft-stage:${workspaceId}:${scope}`, "{not json")
    expect(readStagedDraft(workspaceId, scope)).toBeNull()
  })
})

describe("clearStagedDraft", () => {
  it("removes the staged entry and is idempotent when absent", () => {
    stageDraftContent(workspaceId, scope, makeDoc("hello"))
    clearStagedDraft(workspaceId, scope)
    expect(readStagedDraft(workspaceId, scope)).toBeNull()
    // Second clear is a no-op, not a throw.
    expect(() => clearStagedDraft(workspaceId, scope)).not.toThrow()
  })
})

describe("listStagedDrafts", () => {
  it("lists every staged entry for the workspace and ignores other workspaces", () => {
    stageDraftContent(workspaceId, "stream:a", makeDoc("a"))
    stageDraftContent(workspaceId, "thread:b", makeDoc("b"))
    stageDraftContent("ws_other", "stream:c", makeDoc("c"))

    const entries = listStagedDrafts(workspaceId)
    expect(entries.map((e) => e.scope).sort()).toEqual(["stream:a", "thread:b"])
    expect(listStagedDrafts("ws_other").map((e) => e.scope)).toEqual(["stream:c"])
  })

  it("returns an empty list when nothing is staged", () => {
    expect(listStagedDrafts(workspaceId)).toEqual([])
  })
})
