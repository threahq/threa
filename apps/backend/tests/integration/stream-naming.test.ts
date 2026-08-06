/**
 * Stream Naming Integration Tests
 *
 * Tests verify:
 * 1. needsAutoNaming correctly identifies streams needing naming
 * 2. getEffectiveDisplayName returns correct names for each stream type
 * 3. formatParticipantNames handles various participant counts
 * 4. StreamNamingService database interactions (using stub provider)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTestTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository, type Stream } from "../../src/features/streams"
import {
  needsAutoNaming,
  getEffectiveDisplayName,
  formatParticipantNames,
} from "../../src/features/streams/display-name"
import { setupTestDatabase } from "./setup"
import { userId, workspaceId } from "../../src/lib/id"
import { StreamTypes, Visibilities, CompanionModes } from "@threa/types"

// Helper to create a mock stream object
function createMockStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_test",
    workspaceId: "workspace_test",
    type: "scratchpad",
    displayName: null,
    slug: null,
    description: null,
    visibility: "private",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_test",
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    displayNameGeneratedAt: null,
    ...overrides,
  }
}

describe("Stream Naming", () => {
  let pool: Pool
  let streamService: StreamService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("needsAutoNaming", () => {
    test("returns true for scratchpad without displayName", () => {
      const stream = createMockStream({ type: "scratchpad", displayName: null })
      expect(needsAutoNaming(stream)).toBe(true)
    })

    test("returns true for thread without displayName", () => {
      const stream = createMockStream({ type: "thread", displayName: null })
      expect(needsAutoNaming(stream)).toBe(true)
    })

    test("returns false for thread with displayName", () => {
      const stream = createMockStream({
        type: "thread",
        displayName: "Discussion Thread",
      })
      expect(needsAutoNaming(stream)).toBe(false)
    })

    test("returns false for scratchpad with displayName", () => {
      const stream = createMockStream({
        type: "scratchpad",
        displayName: "My Notes",
      })
      expect(needsAutoNaming(stream)).toBe(false)
    })

    test("returns false for channel (even without displayName)", () => {
      const stream = createMockStream({ type: "channel", displayName: null })
      expect(needsAutoNaming(stream)).toBe(false)
    })

    test("returns false for dm", () => {
      const stream = createMockStream({ type: "dm", displayName: null })
      expect(needsAutoNaming(stream)).toBe(false)
    })
  })

  describe("getEffectiveDisplayName", () => {
    describe("channels", () => {
      test("uses slug for channel display name", () => {
        const stream = createMockStream({
          type: "channel",
          slug: "general",
          displayName: "Different Name",
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("general")
        expect(result.source).toBe("slug")
      })

      test("uses fallback for channel without slug", () => {
        const stream = createMockStream({
          type: "channel",
          slug: null,
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("unnamed-channel")
        expect(result.source).toBe("slug")
      })
    })

    describe("scratchpads", () => {
      test("uses generated name when available", () => {
        const stream = createMockStream({
          type: "scratchpad",
          displayName: "Project Ideas",
          displayNameSource: "generated",
          displayNameGeneratedAt: new Date(),
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("Project Ideas")
        expect(result.source).toBe("generated")
      })

      test("uses placeholder when no name generated", () => {
        const stream = createMockStream({
          type: "scratchpad",
          displayName: null,
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("New scratchpad")
        expect(result.source).toBe("placeholder")
      })

      test("renders a name set at creation, with no auto-namer timestamp", () => {
        // This assertion used to be the opposite, on the theory that a name
        // without `displayNameGeneratedAt` meant it "wasn't set properly".
        // `StreamRepository.insert` has no such column, so that description fit
        // every scratchpad a bot ever created: the name was stored and never
        // rendered, and `needsAutoNaming` (displayName === null) skipped those
        // streams, so nothing ever set the timestamp either.
        const stream = createMockStream({
          type: "scratchpad",
          displayName: "Manual Name",
          displayNameSource: "explicit",
          displayNameGeneratedAt: null,
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("Manual Name")
        expect(result.source).toBe("explicit")
      })

      test("only a genuinely nameless scratchpad gets the placeholder", () => {
        for (const displayName of [null, "", "   "]) {
          const stream = createMockStream({ type: "scratchpad", displayName, displayNameGeneratedAt: null })
          expect(getEffectiveDisplayName(stream)).toEqual({
            displayName: "New scratchpad",
            source: "placeholder",
          })
        }
      })
    })

    describe("threads", () => {
      test("uses generated name when available", () => {
        const stream = createMockStream({
          type: "thread",
          displayName: "Discussion about API",
          displayNameSource: "generated",
          displayNameGeneratedAt: new Date(),
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("Discussion about API")
        expect(result.source).toBe("generated")
      })

      test("uses parent context in placeholder", () => {
        const stream = createMockStream({
          type: "thread",
          displayName: null,
        })
        const result = getEffectiveDisplayName(stream, {
          parentStream: { slug: "general", displayName: null },
        })
        expect(result.displayName).toBe("Thread in #general")
        expect(result.source).toBe("placeholder")
      })

      test("uses parent displayName if no slug", () => {
        const stream = createMockStream({
          type: "thread",
          displayName: null,
        })
        const result = getEffectiveDisplayName(stream, {
          parentStream: { slug: null, displayName: "My Scratchpad" },
        })
        // No # sigil — the parent has no slug, so it is not a channel.
        expect(result.displayName).toBe("Thread in My Scratchpad")
        expect(result.source).toBe("placeholder")
      })

      test("uses generic placeholder without parent context", () => {
        const stream = createMockStream({
          type: "thread",
          displayName: null,
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("New thread")
        expect(result.source).toBe("placeholder")
      })
    })

    describe("DMs", () => {
      test("uses participant names when context provided", () => {
        const stream = createMockStream({ type: "dm" })
        const result = getEffectiveDisplayName(stream, {
          participants: [
            { id: "user_1", name: "Alice" },
            { id: "user_2", name: "Bob" },
          ],
          viewingUserId: "user_1",
        })
        expect(result.displayName).toBe("Bob")
        expect(result.source).toBe("participants")
      })

      test("uses fallback without context", () => {
        const stream = createMockStream({ type: "dm" })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("Direct message")
        expect(result.source).toBe("placeholder")
      })
    })
  })

  describe("formatParticipantNames", () => {
    test("falls back to the only participant when no other participant exists", () => {
      const participants = [{ id: "user_1", name: "Alice" }]
      expect(formatParticipantNames(participants, "user_1")).toBe("Alice")
    })

    test("returns the other participant in a strict 1:1 DM", () => {
      const participants = [
        { id: "user_1", name: "Alice" },
        { id: "user_2", name: "Bob" },
      ]
      expect(formatParticipantNames(participants, "user_1")).toBe("Bob")
    })

    test("uses the first other participant defensively for malformed 3-member input", () => {
      const participants = [
        { id: "user_1", name: "Alice" },
        { id: "user_2", name: "Bob" },
        { id: "user_3", name: "Charlie" },
      ]
      expect(formatParticipantNames(participants, "user_1")).toBe("Bob")
    })
  })

  describe("Stream updateDisplayName", () => {
    test("updates display name and marks as generated", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Name Update Workspace",
          slug: `name-update-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const scratchpad = await streamService.createScratchpad({
        workspaceId: wsId,
        createdBy: ownerId,
      })

      // Initially no display name
      expect(scratchpad.displayName).toBeNull()
      expect(scratchpad.displayNameGeneratedAt).toBeNull()

      // Update with generated name
      const updated = await streamService.updateDisplayName(scratchpad.id, "AI Generated Title", true)

      expect(updated?.displayName).toBe("AI Generated Title")
      expect(updated?.displayNameGeneratedAt).not.toBeNull()
    })

    test("expected revision, source, and workspace mismatches leave the title unchanged", async () => {
      const ownerId = userId()
      const wsId = workspaceId()
      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Stream CAS Workspace",
          slug: `stream-cas-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })
      const scratchpad = await streamService.createScratchpad({ workspaceId: wsId, createdBy: ownerId })
      const first = await StreamRepository.updateDisplayName(pool, {
        workspaceId: wsId,
        streamId: scratchpad.id,
        displayName: "Current title",
        source: "generated",
      })

      for (const guard of [
        { workspaceId: wsId, expectedRevision: first!.displayNameRevision + 1 },
        { workspaceId: wsId, expectedSource: "explicit" as const },
        { workspaceId: workspaceId(), expectedRevision: first!.displayNameRevision },
      ]) {
        expect(
          await StreamRepository.updateDisplayName(pool, {
            ...guard,
            streamId: scratchpad.id,
            displayName: "Stale title",
            source: "generated",
          })
        ).toBeNull()
      }
      expect(await StreamRepository.findById(pool, scratchpad.id)).toMatchObject({
        displayName: "Current title",
        displayNameSource: "generated",
        displayNameRevision: first!.displayNameRevision,
      })
    })

    test("updates display name without marking as generated", async () => {
      const ownerId = userId()
      const wsId = workspaceId()

      await withTestTransaction(pool, async (client) => {
        await WorkspaceRepository.insert(client, {
          id: wsId,
          name: "Manual Name Workspace",
          slug: `manual-name-ws-${wsId}`,
          createdBy: ownerId,
        })
        await addTestMember(client, wsId, ownerId)
      })

      const scratchpad = await streamService.createScratchpad({
        workspaceId: wsId,
        createdBy: ownerId,
      })

      // Update with manual name (not generated)
      const updated = await streamService.updateDisplayName(scratchpad.id, "Manual Title", false)

      expect(updated?.displayName).toBe("Manual Title")
      expect(updated?.displayNameGeneratedAt).toBeNull()
    })
  })
})
