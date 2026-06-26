import { describe, it, expect } from "vitest"
import type { CachedStream } from "@/stores/workspace-store"
import { isPostableStream } from "./board-composer"

function stream(overrides: Partial<CachedStream>): CachedStream {
  return {
    type: "channel",
    archivedAt: null,
    e2eEnabled: false,
    ...overrides,
  } as CachedStream
}

describe("isPostableStream", () => {
  it("accepts live channels and DMs", () => {
    expect(isPostableStream(stream({ type: "channel" }))).toBe(true)
    expect(isPostableStream(stream({ type: "dm" }))).toBe(true)
  })

  it("rejects existing scratchpads (created via a post, never appended to)", () => {
    expect(isPostableStream(stream({ type: "scratchpad" }))).toBe(false)
  })

  it("rejects threads and system streams (not user-authored surfaces)", () => {
    expect(isPostableStream(stream({ type: "thread" }))).toBe(false)
    expect(isPostableStream(stream({ type: "system" }))).toBe(false)
  })

  it("rejects archived streams", () => {
    expect(isPostableStream(stream({ type: "channel", archivedAt: "2026-06-01T00:00:00.000Z" }))).toBe(false)
  })

  it("rejects E2E streams (the board composer doesn't seal yet)", () => {
    expect(isPostableStream(stream({ type: "channel", e2eEnabled: true }))).toBe(false)
  })
})
