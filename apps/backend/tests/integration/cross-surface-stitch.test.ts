/**
 * Cross-surface stitch integration tests (agent-runtimes §2.8 Q8 follow-up).
 *
 * `loadCrossSurfaceStitch` surfaces the channel discussion a thread was spawned
 * from, so a persona pulled from a channel into a thread keeps what it was
 * pulled from. Verifies the anchoring (prefer the spawning message's own
 * conversation, fall back to the most recently active overlapping one), the
 * membership-only stitch depth (the segmenter's primary members, spawning
 * message excluded), eligibility (unresolved + has members), and the
 * priority-fill budget (trim newest-first; non-positive budget → nothing).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { ConversationStatuses, StreamTypes, Visibilities } from "@threa/types"
import { withTestTransaction, addTestMember, setupTestDatabase } from "./setup"
import { testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, type Stream } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository } from "../../src/features/conversations"
import { loadCrossSurfaceStitch } from "../../src/features/agents/companion/cross-surface-stitch"
import { userId, workspaceId, streamId, messageId, conversationId } from "../../src/lib/id"
import type { PoolClient } from "pg"

const BIG_BUDGET = 80_000

/** Seed a workspace + user + channel and return their ids. */
async function seedChannel(client: PoolClient) {
  const wsId = workspaceId()
  const channelId = streamId()
  const workosUserId = userId()

  await WorkspaceRepository.insert(client, {
    id: wsId,
    name: "Cross Surface Workspace",
    slug: `cross-surface-${wsId}`,
    createdBy: workosUserId,
  })
  const ownerId = (await addTestMember(client, wsId, workosUserId)).id

  await StreamRepository.insert(client, {
    id: channelId,
    workspaceId: wsId,
    type: StreamTypes.CHANNEL,
    displayName: "Discussions",
    slug: "discussions",
    visibility: Visibilities.PUBLIC,
    createdBy: ownerId,
  })

  return { wsId, channelId, ownerId }
}

/** Insert a channel message and return its id. */
async function seedMessage(
  client: PoolClient,
  channelId: string,
  ownerId: string,
  sequence: number,
  content: string
): Promise<string> {
  const id = messageId()
  await MessageRepository.insert(client, {
    id,
    streamId: channelId,
    sequence: BigInt(sequence),
    authorId: ownerId,
    authorType: "user",
    ...testMessageContent(content),
  })
  return id
}

/** Spawn a thread from a channel message. */
async function seedThread(
  client: PoolClient,
  wsId: string,
  channelId: string,
  spawningMessageId: string,
  ownerId: string
): Promise<Stream> {
  return StreamRepository.insert(client, {
    id: streamId(),
    workspaceId: wsId,
    type: StreamTypes.THREAD,
    displayName: "Thread",
    visibility: Visibilities.PRIVATE,
    parentStreamId: channelId,
    parentAnchorId: spawningMessageId,
    rootStreamId: channelId,
    createdBy: ownerId,
  })
}

describe("loadCrossSurfaceStitch", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("stitches the spawning conversation's members, excluding the spawning message", async () => {
    await withTestTransaction(pool, async (client) => {
      const { wsId, channelId, ownerId } = await seedChannel(client)

      const before = await seedMessage(client, channelId, ownerId, 1, "We need to pick a deploy window")
      const spawning = await seedMessage(client, channelId, ownerId, 2, "@ariadne what are the risks?")
      const after = await seedMessage(client, channelId, ownerId, 3, "Friday is risky because of the freeze")

      const conv = conversationId()
      await ConversationRepository.insert(client, {
        id: conv,
        streamId: channelId,
        workspaceId: wsId,
        topicSummary: "Choosing a deploy window",
      })
      for (const m of [before, spawning, after]) {
        await ConversationRepository.addPrimaryMessage(client, wsId, conv, m, ownerId)
      }

      const thread = await seedThread(client, wsId, channelId, spawning, ownerId)

      const stitch = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: BIG_BUDGET })

      expect(stitch).not.toBeNull()
      expect(stitch!.topic).toBe("Choosing a deploy window")
      // The spawning message is the thread's anchor already — excluded here.
      expect(stitch!.messages.map((m) => m.id)).toEqual([before, after])
    })
  })

  test("falls back to the most recently active overlapping conversation when the spawning message is unclassified", async () => {
    await withTestTransaction(pool, async (client) => {
      const { wsId, channelId, ownerId } = await seedChannel(client)

      // The spawning @-mention is not (yet) classified into any conversation.
      const spawning = await seedMessage(client, channelId, ownerId, 1, "@ariadne can you help?")
      const liveA = await seedMessage(client, channelId, ownerId, 2, "The migration keeps timing out")
      const liveB = await seedMessage(client, channelId, ownerId, 3, "It's the index rebuild")

      // A stale topic and a live topic both overlap the recent channel window;
      // the more recently active one must win the fallback.
      const stale = conversationId()
      await ConversationRepository.insert(client, {
        id: stale,
        streamId: channelId,
        workspaceId: wsId,
        topicSummary: "Old onboarding chatter",
      })
      const staleMsg = await seedMessage(client, channelId, ownerId, 4, "welcome aboard")
      await ConversationRepository.addPrimaryMessage(client, wsId, stale, staleMsg, ownerId)
      await ConversationRepository.update(client, wsId, stale, { lastActivityAt: new Date("2026-01-01T00:00:00Z") })

      const live = conversationId()
      await ConversationRepository.insert(client, {
        id: live,
        streamId: channelId,
        workspaceId: wsId,
        topicSummary: "Migration timeout",
      })
      for (const m of [liveA, liveB]) {
        await ConversationRepository.addPrimaryMessage(client, wsId, live, m, ownerId)
      }
      await ConversationRepository.update(client, wsId, live, { lastActivityAt: new Date("2026-06-01T00:00:00Z") })

      const thread = await seedThread(client, wsId, channelId, spawning, ownerId)

      const stitch = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: BIG_BUDGET })

      expect(stitch).not.toBeNull()
      expect(stitch!.topic).toBe("Migration timeout")
      expect(stitch!.messages.map((m) => m.id)).toEqual([liveA, liveB])
    })
  })

  test("returns null when nothing in the channel is classified", async () => {
    await withTestTransaction(pool, async (client) => {
      const { wsId, channelId, ownerId } = await seedChannel(client)
      const spawning = await seedMessage(client, channelId, ownerId, 1, "@ariadne hello")
      const thread = await seedThread(client, wsId, channelId, spawning, ownerId)

      const stitch = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: BIG_BUDGET })

      expect(stitch).toBeNull()
    })
  })

  test("ignores a resolved spawning conversation", async () => {
    await withTestTransaction(pool, async (client) => {
      const { wsId, channelId, ownerId } = await seedChannel(client)
      const before = await seedMessage(client, channelId, ownerId, 1, "earlier point")
      const spawning = await seedMessage(client, channelId, ownerId, 2, "@ariadne thoughts?")

      const conv = conversationId()
      await ConversationRepository.insert(client, {
        id: conv,
        streamId: channelId,
        workspaceId: wsId,
        topicSummary: "A wrapped-up topic",
        status: ConversationStatuses.RESOLVED,
      })
      for (const m of [before, spawning]) {
        await ConversationRepository.addPrimaryMessage(client, wsId, conv, m, ownerId)
      }

      const thread = await seedThread(client, wsId, channelId, spawning, ownerId)

      const stitch = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: BIG_BUDGET })

      expect(stitch).toBeNull()
    })
  })

  test("priority-fill budget trims newest-first and yields nothing when the budget is gone", async () => {
    await withTestTransaction(pool, async (client) => {
      const { wsId, channelId, ownerId } = await seedChannel(client)

      const oldest = await seedMessage(client, channelId, ownerId, 1, "A".repeat(100))
      const middle = await seedMessage(client, channelId, ownerId, 2, "B".repeat(100))
      const spawning = await seedMessage(client, channelId, ownerId, 3, "@ariadne?")
      const newest = await seedMessage(client, channelId, ownerId, 4, "C".repeat(100))

      const conv = conversationId()
      await ConversationRepository.insert(client, {
        id: conv,
        streamId: channelId,
        workspaceId: wsId,
        topicSummary: "Long discussion",
      })
      for (const m of [oldest, middle, spawning, newest]) {
        await ConversationRepository.addPrimaryMessage(client, wsId, conv, m, ownerId)
      }

      const thread = await seedThread(client, wsId, channelId, spawning, ownerId)

      // 150 chars holds only the newest member (100) — adding another (200) overflows.
      const trimmed = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: 150 })
      expect(trimmed!.messages.map((m) => m.id)).toEqual([newest])

      // A positive-but-insufficient budget (smaller than even the newest member)
      // fades to nothing rather than overshooting with a forced message.
      const insufficient = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: 50 })
      expect(insufficient).toBeNull()

      // A deep thread leaves no budget — the stitch fades to nothing.
      const exhausted = await loadCrossSurfaceStitch(client, { workspaceId: wsId, thread, maxChars: 0 })
      expect(exhausted).toBeNull()
    })
  })

  test("returns null for a stream that is not a spawned thread", async () => {
    await withTestTransaction(pool, async (client) => {
      const { wsId, channelId, ownerId } = await seedChannel(client)
      const channel = await StreamRepository.findById(client, channelId)

      const stitch = await loadCrossSurfaceStitch(client, {
        workspaceId: wsId,
        thread: channel!,
        maxChars: BIG_BUDGET,
      })

      expect(stitch).toBeNull()
    })
  })
})
