import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import { useWorkspaceEmoji } from "./use-workspace-emoji"
import type { CachedWorkspaceMetadata } from "@/db"
import * as workspaceStoreModule from "@/stores/workspace-store"

let mockMetadata: CachedWorkspaceMetadata | undefined

function createTestWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

describe("useWorkspaceEmoji", () => {
  const workspaceId = "ws_123"
  let queryClient: QueryClient

  beforeEach(() => {
    vi.restoreAllMocks()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mockMetadata = undefined
    vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockImplementation(() => mockMetadata)
  })

  describe("toEmoji", () => {
    it("should return null when metadata not loaded", () => {
      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.toEmoji("thumbsup")).toBeNull()
    })

    it("should return emoji for known shortcode", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [{ shortcode: "thumbsup", emoji: "👍", type: "native", group: "people", order: 0, aliases: [] }],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.toEmoji("thumbsup")).toBe("👍")
    })

    it("should return emoji when shortcode has colons", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [{ shortcode: "thumbsup", emoji: "👍", type: "native", group: "people", order: 0, aliases: [] }],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.toEmoji(":thumbsup:")).toBe("👍")
    })
  })

  describe("getEmoji", () => {
    it("should return full emoji entry for known shortcode", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [{ shortcode: "heart", emoji: "❤️", type: "native", group: "people", order: 0, aliases: ["love"] }],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      const entry = result.current.getEmoji("heart")
      expect(entry?.emoji).toBe("❤️")
      expect(entry?.aliases).toEqual(["love"])
    })

    it("should resolve an alias, not just the primary shortcode", () => {
      // The backend accepts every alias in `:shortcode:` markdown, so the
      // composer input rule and renderer must resolve them too.
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [
          { shortcode: "heart", emoji: "❤️", type: "native", group: "people", order: 0, aliases: ["heart", "love"] },
        ],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.toEmoji(":love:")).toBe("❤️")
      expect(result.current.getEmoji("love")?.shortcode).toBe("heart")
    })

    it("should strip colons from shortcode when looking up", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [{ shortcode: "heart", emoji: "❤️", type: "native", group: "people", order: 0, aliases: [] }],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getEmoji(":heart:")?.emoji).toBe("❤️")
    })

    it("should return undefined for unknown shortcode", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getEmoji("unknown")).toBeUndefined()
    })
  })

  describe("emojis and emojiWeights", () => {
    it("should return emojis list from metadata", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [
          { shortcode: "a", emoji: "🅰️", type: "native", group: "symbols", order: 0, aliases: [] },
          { shortcode: "b", emoji: "🅱️", type: "native", group: "symbols", order: 1, aliases: [] },
        ],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.emojis).toHaveLength(2)
    })

    it("should return emojiWeights from metadata", () => {
      mockMetadata = {
        id: workspaceId,
        workspaceId,
        emojis: [],
        emojiWeights: { thumbsup: 5, heart: 3 },
        commands: [],
        _cachedAt: Date.now(),
      }

      const { result } = renderHook(() => useWorkspaceEmoji(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.emojiWeights).toEqual({ thumbsup: 5, heart: 3 })
    })
  })
})
