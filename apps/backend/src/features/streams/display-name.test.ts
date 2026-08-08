import { describe, expect, test } from "bun:test"
import { getEffectiveDisplayName } from "./display-name"
import type { Stream } from "./repository"

function thread(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: "thread",
    displayName: null,
    slug: null,
    parentStreamId: "stream_parent",
    ...overrides,
  } as Stream
}

describe("thread placeholder display names", () => {
  test("channel parent renders with the # sigil", () => {
    const result = getEffectiveDisplayName(thread(), {
      parentStream: { slug: "general", displayName: null },
    })
    expect(result).toEqual({ displayName: "Thread in #general", source: "placeholder" })
  })

  test("slugless named parent (scratchpad) renders without a phantom # sigil", () => {
    const result = getEffectiveDisplayName(thread(), {
      parentStream: { slug: null, displayName: "Release planning" },
    })
    expect(result).toEqual({ displayName: "Thread in Release planning", source: "placeholder" })
  })

  test("slugless nameless parent falls back to plain Thread, never 'Thread in #channel'", () => {
    const result = getEffectiveDisplayName(thread(), {
      parentStream: { slug: null, displayName: null },
    })
    expect(result).toEqual({ displayName: "Thread", source: "placeholder" })
  })

  test("a generated thread name wins over any placeholder", () => {
    const result = getEffectiveDisplayName(thread({ displayName: "API redesign", displayNameSource: "generated" }), {
      parentStream: { slug: "general", displayName: null },
    })
    expect(result).toEqual({ displayName: "API redesign", source: "generated" })
  })

  test("an explicit name set at creation wins over the placeholder", () => {
    const result = getEffectiveDisplayName(thread({ displayName: "Handover", displayNameSource: "explicit" }), {
      parentStream: { slug: "general", displayName: null },
    })
    expect(result).toEqual({ displayName: "Handover", source: "explicit" })
  })
})

function scratchpad(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_scratchpad",
    workspaceId: "ws_1",
    type: "scratchpad",
    displayName: null,
    slug: null,
    ...overrides,
  } as Stream
}

describe("scratchpad display names", () => {
  test("a name set at creation renders instead of the placeholder", () => {
    const result = getEffectiveDisplayName(
      scratchpad({ displayName: "CC - threa.conversations-match-timeline", displayNameSource: "explicit" })
    )
    expect(result).toEqual({ displayName: "CC - threa.conversations-match-timeline", source: "explicit" })
  })

  test("an auto-generated name still reports itself as generated", () => {
    const result = getEffectiveDisplayName(scratchpad({ displayName: "Board rollup", displayNameSource: "generated" }))
    expect(result).toEqual({ displayName: "Board rollup", source: "generated" })
  })

  test("only a genuinely nameless scratchpad gets the placeholder", () => {
    expect(getEffectiveDisplayName(scratchpad())).toEqual({ displayName: "New scratchpad", source: "placeholder" })
    for (const blank of ["", "   "]) {
      expect(getEffectiveDisplayName(scratchpad({ displayName: blank }))).toEqual({
        displayName: "New scratchpad",
        source: "placeholder",
      })
    }
  })
})
