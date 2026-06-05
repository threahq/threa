import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import { useActors } from "./use-actors"
import type { User, Persona, Bot } from "@threa/types"
import type { CachedWorkspaceUser, CachedPersona, CachedBot } from "@/db"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useWorkspaceEmojiModule from "./use-workspace-emoji"

// Mutable test data — set in beforeEach, read by the mocked store hooks
let mockUsers: CachedWorkspaceUser[] = []
let mockPersonas: CachedPersona[] = []
let mockBots: CachedBot[] = []

function createTestWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function createMember(overrides: Partial<User> & { _cachedAt?: number } = {}): CachedWorkspaceUser {
  return {
    id: "mem_123",
    workspaceId: "ws_123",
    workosUserId: "workos_user_123",
    email: "test@example.com",
    role: "member",
    slug: "test-user",
    name: "Test User",
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: "2024-01-01T00:00:00.000Z",
    _cachedAt: Date.now(),
    ...overrides,
  }
}

function createPersona(overrides: Partial<Persona> & { _cachedAt?: number } = {}): CachedPersona {
  return {
    id: "persona_123",
    workspaceId: null,
    slug: "test-persona",
    name: "Test Persona",
    description: null,
    avatarEmoji: null,
    systemPrompt: null,
    model: "claude-sonnet-4-20250514",
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    managedBy: "system",
    status: "active",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    _cachedAt: Date.now(),
    ...overrides,
  }
}

function createBot(overrides: Partial<Bot> & { _cachedAt?: number } = {}): CachedBot {
  return {
    id: "bot_123",
    workspaceId: "ws_123",
    type: "shared",
    ownerUserId: null,
    traits: [],
    slug: null,
    name: "Test Bot",
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    archivedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    _cachedAt: Date.now(),
    ...overrides,
  }
}

describe("useActors", () => {
  const workspaceId = "ws_123"
  let queryClient: QueryClient

  beforeEach(() => {
    vi.restoreAllMocks()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    mockUsers = []
    mockPersonas = []
    mockBots = []

    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation(() => mockUsers)
    vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockImplementation(() => mockPersonas)
    vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockImplementation(() => mockBots)
    vi.spyOn(useWorkspaceEmojiModule, "useWorkspaceEmoji").mockReturnValue({
      toEmoji: (shortcode: string) => {
        // Simple test implementation: resolve :thread: -> 🧵
        if (shortcode === ":thread:") return "🧵"
        return undefined
      },
    } as unknown as ReturnType<typeof useWorkspaceEmojiModule.useWorkspaceEmoji>)
  })

  describe("getActorName", () => {
    it("should return 'Unknown' for null actorId", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName(null, null)).toBe("Unknown")
    })

    it("should return user display name when found", () => {
      mockUsers = [createMember({ id: "mem_123", name: "John Doe" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName("mem_123", "user")).toBe("John Doe")
    })

    it("should return truncated ID when user not found", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName("mem_12345678", "user")).toBe("mem_1234")
    })

    it("should return persona name for persona actor type", () => {
      mockPersonas = [createPersona({ id: "persona_123", slug: "ariadne", name: "Ariadne", avatarEmoji: "🧵" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName("persona_123", "persona")).toBe("Ariadne")
    })

    it("should return 'AI Companion' when persona not found", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName("persona_unknown", "persona")).toBe("AI Companion")
    })

    it("should return 'Threa' for system actor type", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName("system", "system")).toBe("Threa")
    })

    it("should return bot name for bot actor type", () => {
      mockBots = [createBot({ id: "bot_123", name: "MyBot" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorName("bot_123", "bot")).toBe("MyBot")
    })
  })

  describe("getActorInitials", () => {
    it("should return '?' for null actorId", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorInitials(null, null)).toBe("?")
    })

    it("should return initials from user display name", () => {
      mockUsers = [createMember({ id: "mem_123", name: "John Doe" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorInitials("mem_123", "user")).toBe("JD")
    })

    it("should return avatar emoji for persona", () => {
      mockPersonas = [createPersona({ id: "persona_123", slug: "ariadne", name: "Ariadne", avatarEmoji: ":thread:" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorInitials("persona_123", "persona")).toBe("🧵")
    })

    it("should return persona initials when no avatar emoji", () => {
      mockPersonas = [
        createPersona({
          id: "persona_456",
          workspaceId: "ws_123",
          slug: "custom-bot",
          name: "Custom Bot",
          avatarEmoji: null,
          managedBy: "workspace",
        }),
      ]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorInitials("persona_456", "persona")).toBe("CB")
    })

    it("should return truncated ID when user not found", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorInitials("ab_12345678", "user")).toBe("AB")
    })

    it("should return 'T' for system actor type", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorInitials("system", "system")).toBe("T")
    })
  })

  describe("getPersona", () => {
    it("should return persona when found", () => {
      mockPersonas = [createPersona({ id: "persona_123", slug: "ariadne", name: "Ariadne", avatarEmoji: "🧵" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })

      const foundPersona = result.current.getPersona("persona_123")
      expect(foundPersona?.id).toBe("persona_123")
      expect(foundPersona?.name).toBe("Ariadne")
    })

    it("should return undefined when persona not found", () => {
      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getPersona("nonexistent")).toBeUndefined()
    })
  })

  describe("getActorAvatar status", () => {
    it("resolves an active status emoji to a glyph and carries the text", () => {
      mockUsers = [createMember({ id: "mem_123", statusEmoji: ":thread:", statusText: "Focusing" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").status).toEqual({
        emoji: "🧵",
        text: "Focusing",
        expiresAt: null,
      })
    })

    it("returns a text-only status with a null glyph", () => {
      mockUsers = [createMember({ id: "mem_123", statusEmoji: null, statusText: "Heads down" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").status).toEqual({
        emoji: null,
        text: "Heads down",
        expiresAt: null,
      })
    })

    it("carries a future expiry through", () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockUsers = [
        createMember({ id: "mem_123", statusEmoji: ":thread:", statusText: "Focus", statusExpiresAt: future }),
      ]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").status).toEqual({
        emoji: "🧵",
        text: "Focus",
        expiresAt: future,
      })
    })

    it("masks an expired status", () => {
      const expired = new Date(Date.now() - 60_000).toISOString()
      mockUsers = [
        createMember({ id: "mem_123", statusEmoji: ":thread:", statusText: "Old", statusExpiresAt: expired }),
      ]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").status).toBeUndefined()
    })

    it("omits status for users without one", () => {
      mockUsers = [createMember({ id: "mem_123" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").status).toBeUndefined()
    })
  })

  describe("getActorAvatar dnd", () => {
    it("flags do-not-disturb for an active status that pauses notifications", () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
      mockUsers = [
        createMember({
          id: "mem_123",
          statusEmoji: ":no_bell:",
          statusText: "Do not disturb",
          statusExpiresAt: future,
          statusPausesNotifications: true,
        }),
      ]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").dnd).toBe(true)
    })

    it("flags do-not-disturb for an indefinite manual pause", () => {
      mockUsers = [createMember({ id: "mem_123", notificationsPausedIndefinitely: true })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").dnd).toBe(true)
    })

    it("flags do-not-disturb for a manual pause still in its window", () => {
      const future = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      mockUsers = [createMember({ id: "mem_123", notificationsPausedUntil: future })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").dnd).toBe(true)
    })

    it("does not flag do-not-disturb for an elapsed manual pause", () => {
      const past = new Date(Date.now() - 60_000).toISOString()
      mockUsers = [createMember({ id: "mem_123", notificationsPausedUntil: past })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").dnd).toBeUndefined()
    })

    it("does not flag do-not-disturb when a status carries no pause flag", () => {
      mockUsers = [createMember({ id: "mem_123", statusEmoji: ":thread:", statusText: "Focus" })]

      const { result } = renderHook(() => useActors(workspaceId), {
        wrapper: createTestWrapper(queryClient),
      })
      expect(result.current.getActorAvatar("mem_123", "user").dnd).toBeUndefined()
    })
  })
})
