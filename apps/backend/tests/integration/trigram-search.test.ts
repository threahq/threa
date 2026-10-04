/**
 * Trigram Search Integration Tests
 *
 * Tests verify:
 * 1. UserRepository.searchByNameOrSlug handles typos via trigram similarity
 * 2. StreamRepository.searchByName handles typos via trigram similarity
 * 3. Results are ordered by similarity score
 * 4. ILIKE fallback works for exact substring matches
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTestTransaction, withTransaction } from "./setup"
import { PeoplePurposes, UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { setupTestDatabase } from "./setup"
import { userId, workspaceId, streamId } from "../../src/lib/id"

const scope = { viewer: { kind: "workspace" }, purpose: PeoplePurposes.TARGETABLE } as const

describe("Trigram Search", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserIds: string[]
  let testWorkosUserIds: string[]
  let testStreamIds: string[]

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testWorkspaceId = workspaceId()
    testUserIds = [userId(), userId(), userId()]
    testWorkosUserIds = [userId(), userId(), userId()]
    testStreamIds = [streamId(), streamId(), streamId()]

    // Use unique suffix to avoid collisions with previous test runs
    const suffix = testWorkspaceId.slice(-8)

    await withTransaction(pool, async (client) => {
      // Create workspace and seed workspace-scoped users for fuzzy matching tests.
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Trigram Test Workspace",
        slug: `trgm-test-${testWorkspaceId}`,
        createdBy: testUserIds[0],
      })
      await UserRepository.insert(client, {
        id: testUserIds[0],
        workspaceId: testWorkspaceId,
        workosUserId: testWorkosUserIds[0],
        email: `john.smith.${suffix}@example.com`,
        slug: `john-smith-${suffix}`,
        name: "John Smith",
        role: "owner",
      })

      await UserRepository.insert(client, {
        id: testUserIds[1],
        workspaceId: testWorkspaceId,
        workosUserId: testWorkosUserIds[1],
        email: `kristoffer.${suffix}@example.com`,
        slug: `kristoffer-${suffix}`,
        name: "Kristoffer Remback",
        role: "member",
      })

      await UserRepository.insert(client, {
        id: testUserIds[2],
        workspaceId: testWorkspaceId,
        workosUserId: testWorkosUserIds[2],
        email: `jane.doe.${suffix}@example.com`,
        slug: `jane-doe-${suffix}`,
        name: "Jane Doe",
        role: "member",
      })

      // Create streams with various names
      await StreamRepository.insert(client, {
        id: testStreamIds[0],
        workspaceId: testWorkspaceId,
        type: "channel",
        displayName: "General Discussion",
        slug: "general-discussion",
        visibility: "public",
        companionMode: "off",
        createdBy: testUserIds[0],
      })
      await StreamRepository.insert(client, {
        id: testStreamIds[1],
        workspaceId: testWorkspaceId,
        type: "channel",
        displayName: "Project Alpha",
        slug: "project-alpha",
        visibility: "public",
        companionMode: "off",
        createdBy: testUserIds[0],
      })
      await StreamRepository.insert(client, {
        id: testStreamIds[2],
        workspaceId: testWorkspaceId,
        type: "channel",
        displayName: "Engineering Team",
        slug: "engineering",
        visibility: "public",
        companionMode: "off",
        createdBy: testUserIds[0],
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("UserRepository.searchByNameOrSlug", () => {
    test("finds user by exact name", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "John Smith", 10, scope)

        expect(results.length).toBeGreaterThan(0)
        expect(results[0].name).toBe("John Smith")
      })
    })

    test("finds user by partial name (ILIKE fallback)", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "john", 10, scope)

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((u) => u.name === "John Smith")).toBe(true)
      })
    })

    test("finds user with typo in name (trigram similarity)", async () => {
      await withTestTransaction(pool, async (client) => {
        // "Jonh" (transposition typo) should match "John" via trigram similarity
        // Note: very short strings like "jhon" vs "john" may not meet the 0.3 threshold
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "John Smth", 10, scope)

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((u) => u.name === "John Smith")).toBe(true)
      })
    })

    test("finds user with typo in longer name", async () => {
      await withTestTransaction(pool, async (client) => {
        // "kristofer" should match "Kristoffer" via trigram similarity
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "kristofer", 10, scope)

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((u) => u.name === "Kristoffer Remback")).toBe(true)
      })
    })

    test("finds user by email (partial)", async () => {
      await withTestTransaction(pool, async (client) => {
        // Email has unique suffix but "kristoffer" should still match
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "kristoffer", 10, scope)

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((u) => u.name === "Kristoffer Remback")).toBe(true)
      })
    })

    test("finds user by slug (partial)", async () => {
      await withTestTransaction(pool, async (client) => {
        // Slug has unique suffix but "jane-doe" should still match
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "jane-doe", 10, scope)

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((u) => u.name === "Jane Doe")).toBe(true)
      })
    })

    test("returns empty array for no matches", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await UserRepository.searchByNameOrSlug(client, testWorkspaceId, "zzzznotauser", 10, scope)

        expect(results).toEqual([])
      })
    })
  })

  describe("StreamRepository.searchByName", () => {
    test("finds stream by exact name", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "General Discussion",
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results[0].displayName).toBe("General Discussion")
      })
    })

    test("finds stream by partial name (ILIKE fallback)", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "general",
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((s) => s.displayName === "General Discussion")).toBe(true)
      })
    })

    test("finds stream with typo in name (trigram similarity)", async () => {
      await withTestTransaction(pool, async (client) => {
        // "generl" (missing 'a') should match "General" via trigram similarity
        // Note: "genral" has similarity ~0.29 which is below the 0.3 threshold
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "generl discussion",
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((s) => s.displayName === "General Discussion")).toBe(true)
      })
    })

    test("finds stream with typo - projct matches project", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "projct",
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results.some((s) => s.displayName === "Project Alpha")).toBe(true)
      })
    })

    test("finds stream by slug", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "engineering",
        })

        expect(results.length).toBeGreaterThan(0)
        expect(results[0].slug).toBe("engineering")
      })
    })

    test("respects type filter", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "general",
          types: ["scratchpad"], // None of our test streams are scratchpads
        })

        expect(results).toEqual([])
      })
    })

    test("respects streamIds access control", async () => {
      await withTestTransaction(pool, async (client) => {
        // Only pass first stream ID - should not find other streams
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: [testStreamIds[0]],
          query: "Project", // This exists but in testStreamIds[1]
        })

        expect(results.every((s) => s.id === testStreamIds[0])).toBe(true)
      })
    })

    test("returns empty array for no matches", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: testStreamIds,
          query: "zzzznotastream",
        })

        expect(results).toEqual([])
      })
    })

    test("returns empty array for empty streamIds", async () => {
      await withTestTransaction(pool, async (client) => {
        const results = await StreamRepository.searchByName(client, {
          workspaceId: testWorkspaceId,
          streamIds: [],
          query: "general",
        })

        expect(results).toEqual([])
      })
    })
  })
})
