import { describe, it, expect } from "vitest"
import { filterMentionables, filterBroadcastMentions } from "./use-mentionables"
import type { Mentionable } from "@/components/editor/triggers/types"

/**
 * Note: useMentionables hook tests require full ServicesProvider context
 * which is complex to set up. The hook combines data from useWorkspaceBootstrap
 * with broadcast mentions. The core logic is tested via filterMentionables below.
 *
 * Integration testing of useMentionables is covered by E2E tests.
 */

describe("filterMentionables", () => {
  const mentionables: Mentionable[] = [
    { id: "usr_1", slug: "alice", name: "Alice Smith", type: "user" },
    { id: "usr_2", slug: "bob", name: "Bob Jones", type: "user" },
    { id: "persona_1", slug: "ariadne", name: "Ariadne", type: "persona", avatarEmoji: "🧵" },
    { id: "broadcast:channel", slug: "channel", name: "Channel", type: "broadcast", avatarEmoji: "📢" },
    { id: "broadcast:here", slug: "here", name: "Here", type: "broadcast", avatarEmoji: "👋" },
  ]

  it("should return all items when query is empty", () => {
    const result = filterMentionables(mentionables, "")
    expect(result).toHaveLength(5)
  })

  it("should filter by slug (case-insensitive)", () => {
    const result = filterMentionables(mentionables, "ali")
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe("alice")
  })

  it("should filter by name (case-insensitive)", () => {
    const result = filterMentionables(mentionables, "smith")
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Alice Smith")
  })

  it("should match partial slug", () => {
    const result = filterMentionables(mentionables, "ari")
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe("ariadne")
  })

  it("should match partial name", () => {
    const result = filterMentionables(mentionables, "jon")
    expect(result).toHaveLength(1)
    expect(result[0].slug).toBe("bob")
  })

  it("should be case-insensitive", () => {
    const resultLower = filterMentionables(mentionables, "alice")
    const resultUpper = filterMentionables(mentionables, "ALICE")
    const resultMixed = filterMentionables(mentionables, "AlIcE")

    expect(resultLower).toHaveLength(1)
    expect(resultUpper).toHaveLength(1)
    expect(resultMixed).toHaveLength(1)
  })

  it("should return empty array when no matches", () => {
    const result = filterMentionables(mentionables, "xyz")
    expect(result).toHaveLength(0)
  })

  it("should match multiple items", () => {
    // Both "channel" and "here" contain 'e'
    const result = filterMentionables(mentionables, "e")
    expect(result.length).toBeGreaterThan(1)
  })

  it("should match broadcast mentions", () => {
    const result = filterMentionables(mentionables, "chan")
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("broadcast")
  })

  it("should handle empty mentionables array", () => {
    const result = filterMentionables([], "alice")
    expect(result).toHaveLength(0)
  })

  it("should handle single character query", () => {
    const result = filterMentionables(mentionables, "a")
    // Matches: alice (slug), Ariadne (slug/name), Channel (name)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it("should rank prefix matches above mid-word substring matches", () => {
    const withMidWordMatch: Mentionable[] = [
      // Defined first and matches "ali" only mid-word; the prefix match must win.
      { id: "usr_9", slug: "natalie", name: "Natalie Doe", type: "user" },
      { id: "usr_1", slug: "alice", name: "Alice Smith", type: "user" },
    ]
    const result = filterMentionables(withMidWordMatch, "ali")
    expect(result.map((item) => item.slug)).toEqual(["alice", "natalie"])
  })
})

describe("filterBroadcastMentions", () => {
  const slugs = (items: Mentionable[]) => items.map((m) => m.slug).sort()

  it("returns both when no context provided (backwards-compatible)", () => {
    expect(slugs(filterBroadcastMentions())).toEqual(["channel", "here"])
  })

  it("returns both in a channel", () => {
    expect(slugs(filterBroadcastMentions({ streamType: "channel" }))).toEqual(["channel", "here"])
  })

  it("returns both in a thread under a channel", () => {
    expect(slugs(filterBroadcastMentions({ streamType: "thread", rootStreamType: "channel" }))).toEqual([
      "channel",
      "here",
    ])
  })

  it("returns only @here in a DM", () => {
    expect(slugs(filterBroadcastMentions({ streamType: "dm" }))).toEqual(["here"])
  })

  it("returns only @here in a thread under a DM", () => {
    expect(slugs(filterBroadcastMentions({ streamType: "thread", rootStreamType: "dm" }))).toEqual(["here"])
  })

  it("returns empty in a scratchpad", () => {
    expect(filterBroadcastMentions({ streamType: "scratchpad" })).toEqual([])
  })

  it("returns empty in a thread under a scratchpad", () => {
    expect(filterBroadcastMentions({ streamType: "thread", rootStreamType: "scratchpad" })).toEqual([])
  })

  it("returns empty for system streams", () => {
    expect(filterBroadcastMentions({ streamType: "system" })).toEqual([])
  })
})
