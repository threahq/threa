import { describe, expect, test } from "bun:test"
import { getEffectiveDisplayName } from "./display-name"
import type { Stream } from "./repository"

function thread(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_thread",
    workspaceId: "ws_1",
    type: "thread",
    displayName: null,
    displayNameGeneratedAt: null,
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
    const result = getEffectiveDisplayName(
      thread({ displayName: "API redesign", displayNameGeneratedAt: new Date() }),
      { parentStream: { slug: "general", displayName: null } }
    )
    expect(result).toEqual({ displayName: "API redesign", source: "generated" })
  })
})
