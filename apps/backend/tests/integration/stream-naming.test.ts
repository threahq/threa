/**
 * Stream Naming Integration Tests
 *
 * Tests verify:
 * 1. getEffectiveDisplayName returns correct names for each stream type
 * 2. formatParticipantNames handles participant projections
 * 3. revision-fenced dynamic naming updates real schema rows
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTransaction } from "../../src/db"
import { withTestTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService, StreamRepository, type Stream } from "../../src/features/streams"
import { getEffectiveDisplayName, formatParticipantNames } from "../../src/features/streams/display-name"
import { setupTestDatabase } from "./setup"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { StreamTypes, Visibilities, CompanionModes } from "@threa/types"
import { MessageRepository } from "../../src/features/messaging"
import { MessageFormatter } from "../../src/lib/ai/message-formatter"
import {
  DynamicNamingService,
  DynamicNamingStreamTarget,
  type DynamicNamingDecision,
  type DynamicNamingEvaluationInput,
} from "../../src/features/dynamic-naming"

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

      test("renders an explicit name set at creation", () => {
        const stream = createMockStream({
          type: "scratchpad",
          displayName: "Manual Name",
          displayNameSource: "explicit",
        })
        const result = getEffectiveDisplayName(stream)
        expect(result.displayName).toBe("Manual Name")
        expect(result.source).toBe("explicit")
      })

      test("only a genuinely nameless scratchpad gets the placeholder", () => {
        for (const displayName of [null, "", "   "]) {
          const stream = createMockStream({ type: "scratchpad", displayName })
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

  describe("Stream title revision", () => {
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
  })
})

describe("Dynamic plaintext stream naming", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function createScratchpad(messageCount = 1) {
    const ownerId = userId()
    const wsId = workspaceId()
    await withTestTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Dynamic Naming Workspace",
        slug: `dynamic-naming-${wsId}`,
        createdBy: ownerId,
      })
      await addTestMember(client, wsId, ownerId)
    })
    const stream = await new StreamService(pool).createScratchpad({ workspaceId: wsId, createdBy: ownerId })
    await withTransaction(pool, async (client) => {
      for (let index = 1; index <= messageCount; index += 1) {
        await MessageRepository.insert(client, {
          id: messageId(),
          streamId: stream.id,
          sequence: BigInt(index),
          authorId: ownerId,
          authorType: "user",
          ...testMessageContent(`Message ${index} about lunar gardening`),
        })
      }
    })
    return { ownerId, wsId, stream }
  }

  function buildService(
    decide: (input: DynamicNamingEvaluationInput) => Promise<DynamicNamingDecision>,
    scheduled: Date[] = []
  ) {
    return new DynamicNamingService(
      pool,
      new Map([["stream", new DynamicNamingStreamTarget(pool, new MessageFormatter())]]),
      { decide },
      {
        schedule: async (_data, processAfter) => {
          if (processAfter) scheduled.push(processAfter)
        },
      },
      () => new Date(Date.now() + 10_000)
    )
  }

  test("renames an unnamed scratchpad and records generated provenance", async () => {
    const { wsId, stream } = await createScratchpad()
    const service = buildService(async (input) => {
      expect(input).toMatchObject({ checkpoint: 1, forced: false, currentTitle: null, messageCount: 1 })
      expect(input.context).toContain("lunar gardening")
      return { action: "rename", title: "Lunar gardening" }
    })

    expect(await service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: stream.id }, "job_1")).toEqual({
      status: "evaluated",
      action: "rename",
      revision: 1,
    })
    expect(await StreamRepository.findById(pool, stream.id)).toMatchObject({
      displayName: "Lunar gardening",
      displayNameSource: "generated",
      displayNameRevision: 1,
    })
  })

  test("a manual rename during evaluation invalidates the generated result", async () => {
    const { ownerId, wsId, stream } = await createScratchpad()
    const service = buildService(async () => {
      await StreamRepository.updateDisplayName(pool, {
        workspaceId: wsId,
        streamId: stream.id,
        displayName: "My garden notes",
        source: "explicit",
        updatedByUserId: ownerId,
      })
      return { action: "rename", title: "Stale model title" }
    })

    expect(
      await service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: stream.id }, "job_manual")
    ).toEqual({ status: "stale" })
    expect(await StreamRepository.findById(pool, stream.id)).toMatchObject({
      displayName: "My garden notes",
      displayNameSource: "explicit",
      displayNameRevision: 1,
    })
  })

  test("two jobs for one checkpoint make one model call", async () => {
    const { wsId, stream } = await createScratchpad()
    let calls = 0
    let startEvaluation: (() => void) | undefined
    const evaluationStarted = new Promise<void>((resolve) => {
      startEvaluation = resolve
    })
    let finishEvaluation: (() => void) | undefined
    const evaluationGate = new Promise<void>((resolve) => {
      finishEvaluation = resolve
    })
    const scheduled: Date[] = []
    const service = buildService(async () => {
      calls += 1
      startEvaluation?.()
      await evaluationGate
      return { action: "rename", title: "One model title" }
    }, scheduled)

    const first = service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: stream.id }, "job_a")
    await evaluationStarted
    const second = await service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: stream.id }, "job_b")
    finishEvaluation?.()
    await first

    expect({ calls, secondStatus: second.status, scheduled: scheduled.length }).toEqual({
      calls: 1,
      secondStatus: "requeued",
      scheduled: 1,
    })
  })

  test("thread context starts with its anchor while counting only replies", async () => {
    const ownerId = userId()
    const wsId = workspaceId()
    const rootId = streamId()
    const threadId = streamId()
    const anchorId = messageId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: rootId,
        workspaceId: wsId,
        type: "channel",
        slug: "gardening",
        visibility: "private",
        companionMode: "off",
        createdBy: ownerId,
      })
      await MessageRepository.insert(client, {
        id: anchorId,
        streamId: rootId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Anchor about moon soil"),
      })
      await StreamRepository.insert(client, {
        id: threadId,
        workspaceId: wsId,
        type: "thread",
        parentStreamId: rootId,
        rootStreamId: rootId,
        parentAnchorId: anchorId,
        visibility: "private",
        companionMode: "off",
        createdBy: ownerId,
      })
      await MessageRepository.insert(client, {
        id: messageId(),
        streamId: threadId,
        sequence: 2n,
        authorId: ownerId,
        authorType: "user",
        ...testMessageContent("Reply about watering"),
      })
    })
    const service = buildService(async (input) => {
      expect(input.messageCount).toBe(1)
      expect(input.context.indexOf("Anchor about moon soil")).toBeLessThan(
        input.context.indexOf("Reply about watering")
      )
      return { action: "rename", title: "Moon soil watering" }
    })

    expect(
      await service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: threadId }, "job_thread")
    ).toMatchObject({ status: "evaluated", action: "rename" })
  })

  test("waits for the five-second quiet deadline before claiming", async () => {
    const { wsId, stream } = await createScratchpad()
    let calls = 0
    const scheduled: Date[] = []
    const service = new DynamicNamingService(
      pool,
      new Map([["stream", new DynamicNamingStreamTarget(pool, new MessageFormatter())]]),
      {
        decide: async () => {
          calls += 1
          return { action: "rename", title: "Too early" }
        },
      },
      {
        schedule: async (_data, processAfter) => {
          if (processAfter) scheduled.push(processAfter)
        },
      }
    )

    const result = await service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: stream.id }, "job_quiet")
    expect({ status: result.status, calls, scheduled: scheduled.length }).toEqual({
      status: "requeued",
      calls: 0,
      scheduled: 1,
    })
  })

  test("two consecutive keeps settle a generated title after checkpoints 3 and 6", async () => {
    const { ownerId, wsId, stream } = await createScratchpad()
    const checkpoints: number[] = []
    const service = buildService(async (input) => {
      checkpoints.push(input.checkpoint)
      return input.checkpoint === 1 ? { action: "rename", title: "Lunar garden" } : { action: "keep" }
    })
    const ref = { workspaceId: wsId, targetKind: "stream" as const, targetId: stream.id }

    await service.evaluate(ref, "job_cp1")
    await withTransaction(pool, async (client) => {
      for (let sequence = 2; sequence <= 3; sequence += 1) {
        await MessageRepository.insert(client, {
          id: messageId(),
          streamId: stream.id,
          sequence: BigInt(sequence),
          authorId: ownerId,
          authorType: "user",
          ...testMessageContent(`Lunar garden detail ${sequence}`),
        })
      }
    })
    await service.evaluate(ref, "job_cp3")
    await withTransaction(pool, async (client) => {
      for (let sequence = 4; sequence <= 6; sequence += 1) {
        await MessageRepository.insert(client, {
          id: messageId(),
          streamId: stream.id,
          sequence: BigInt(sequence),
          authorId: ownerId,
          authorType: "user",
          ...testMessageContent(`Lunar garden detail ${sequence}`),
        })
      }
    })
    await service.evaluate(ref, "job_cp6")
    await service.evaluate(ref, "job_after_settle")

    expect(checkpoints).toEqual([1, 3, 6])
  })

  test("an old-path generated title starts refinement after checkpoint 1", async () => {
    const { wsId, stream } = await createScratchpad(3)
    await StreamRepository.updateDisplayName(pool, {
      workspaceId: wsId,
      streamId: stream.id,
      displayName: "Opening title",
      source: "generated",
    })
    let observedCheckpoint: number | null = null
    const service = buildService(async (input) => {
      observedCheckpoint = input.checkpoint
      return { action: "keep" }
    })

    await service.evaluate({ workspaceId: wsId, targetKind: "stream", targetId: stream.id }, "job_seed")
    expect(observedCheckpoint).toBe(3)
  })
})
