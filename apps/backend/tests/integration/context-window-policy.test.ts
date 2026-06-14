/**
 * Context Window Policy Integration Tests
 *
 * `resolveContextWindowPolicy` fixes the per-turn window budget and whether the
 * prior turn digests carry (the DM episode boundary, agent-runtimes §2.8 Q7/Q8).
 *
 * Verifies:
 * 1. Bounded surfaces (scratchpad/thread/channel) are one episode — always carry.
 * 2. A DM with no prior completed session starts fresh (nothing to carry).
 * 3. A DM continues — carrying digests — when the prior session's cursor is
 *    still inside the budgeted window.
 * 4. A DM starts fresh when that cursor fell outside the window (a gap larger
 *    than the budget).
 * 5. A DM whose whole history fits inside the window always continues.
 * 6. The in-flight RUNNING session is ignored; the PRIOR completed one decides.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { withTestTransaction, setupTestDatabase, testMessageContent, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository, type Stream } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { AgentSessionRepository, SessionStatuses, resolveContextWindowPolicy } from "../../src/features/agents"
import type { PoolClient } from "pg"
import { userId, workspaceId, streamId, messageId, sessionId, personaId } from "../../src/lib/id"
import { StreamTypes, Visibilities } from "@threa/types"

type StreamType = (typeof StreamTypes)[keyof typeof StreamTypes]

const TEST_PERSONA_ID = personaId()

async function setupWorkspaceMember(client: PoolClient): Promise<{ workspaceId: string; memberId: string }> {
  const wsId = workspaceId()
  const workosUserId = userId()
  await WorkspaceRepository.insert(client, {
    id: wsId,
    name: "Window Policy Workspace",
    slug: `cwp-ws-${wsId}`,
    createdBy: workosUserId,
  })
  const member = await addTestMember(client, wsId, workosUserId)
  return { workspaceId: wsId, memberId: member.id }
}

async function insertStream(client: PoolClient, wsId: string, memberId: string, type: StreamType): Promise<Stream> {
  return StreamRepository.insert(client, {
    id: streamId(),
    workspaceId: wsId,
    type,
    displayName: type === StreamTypes.DM ? undefined : `${type} stream`,
    visibility: Visibilities.PRIVATE,
    createdBy: memberId,
  })
}

async function insertMessages(client: PoolClient, streamIdArg: string, authorId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await MessageRepository.insert(client, {
      id: messageId(),
      streamId: streamIdArg,
      sequence: BigInt(i),
      authorId,
      authorType: "user",
      ...testMessageContent(`message ${i}`),
    })
  }
}

async function insertCompletedSession(
  client: PoolClient,
  streamIdArg: string,
  lastSeenSequence: bigint
): Promise<void> {
  const id = sessionId()
  await AgentSessionRepository.insert(client, {
    id,
    streamId: streamIdArg,
    personaId: TEST_PERSONA_ID,
    triggerMessageId: messageId(),
    status: SessionStatuses.RUNNING,
    serverId: "test-server",
  })
  await AgentSessionRepository.completeSession(client, id, { lastSeenSequence })
}

describe("resolveContextWindowPolicy", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("bounded surfaces are one episode — always carry digests", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const scratchpad = await insertStream(client, wsId, memberId, StreamTypes.SCRATCHPAD)

      const policy = await resolveContextWindowPolicy(client, { stream: scratchpad, maxMessages: 3 })

      expect(policy).toEqual({ episode: { kind: "stream" }, maxMessages: 3, carryDigests: true })
    })
  })

  test("DM with no prior completed session starts fresh", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const dm = await insertStream(client, wsId, memberId, StreamTypes.DM)
      await insertMessages(client, dm.id, memberId, 5)

      const policy = await resolveContextWindowPolicy(client, { stream: dm, maxMessages: 3 })

      expect(policy).toEqual({ episode: { kind: "dm-recency", continues: false }, maxMessages: 3, carryDigests: false })
    })
  })

  test("DM continues when the prior cursor is inside the window", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const dm = await insertStream(client, wsId, memberId, StreamTypes.DM)
      await insertMessages(client, dm.id, memberId, 5) // budget 3 → window floor is sequence 3
      await insertCompletedSession(client, dm.id, BigInt(4)) // 4 >= 3, inside

      const policy = await resolveContextWindowPolicy(client, { stream: dm, maxMessages: 3 })

      expect(policy).toEqual({ episode: { kind: "dm-recency", continues: true }, maxMessages: 3, carryDigests: true })
    })
  })

  test("DM starts fresh when the prior cursor fell outside the window", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const dm = await insertStream(client, wsId, memberId, StreamTypes.DM)
      await insertMessages(client, dm.id, memberId, 5) // budget 3 → window floor is sequence 3
      await insertCompletedSession(client, dm.id, BigInt(2)) // 2 < 3, outside → gap > window

      const policy = await resolveContextWindowPolicy(client, { stream: dm, maxMessages: 3 })

      expect(policy).toEqual({ episode: { kind: "dm-recency", continues: false }, maxMessages: 3, carryDigests: false })
    })
  })

  test("DM continues when its whole history fits inside the window", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const dm = await insertStream(client, wsId, memberId, StreamTypes.DM)
      await insertMessages(client, dm.id, memberId, 2) // fewer than budget 3 → no floor
      await insertCompletedSession(client, dm.id, BigInt(1))

      const policy = await resolveContextWindowPolicy(client, { stream: dm, maxMessages: 3 })

      expect(policy).toEqual({ episode: { kind: "dm-recency", continues: true }, maxMessages: 3, carryDigests: true })
    })
  })

  test("DM ignores the in-flight running session and reads the prior completed one", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const dm = await insertStream(client, wsId, memberId, StreamTypes.DM)
      await insertMessages(client, dm.id, memberId, 5)
      await insertCompletedSession(client, dm.id, BigInt(4)) // prior episode, cursor inside

      // The current turn's RUNNING session (no lastSeenSequence yet) must not
      // shadow the prior completed session's cursor.
      await AgentSessionRepository.insert(client, {
        id: sessionId(),
        streamId: dm.id,
        personaId: TEST_PERSONA_ID,
        triggerMessageId: messageId(),
        status: SessionStatuses.RUNNING,
        serverId: "test-server",
      })

      const policy = await resolveContextWindowPolicy(client, { stream: dm, maxMessages: 3 })

      expect(policy).toEqual({ episode: { kind: "dm-recency", continues: true }, maxMessages: 3, carryDigests: true })
    })
  })

  test("clamps a degenerate window budget so it can't continue into an empty window", async () => {
    await withTestTransaction(pool, async (client) => {
      const { workspaceId: wsId, memberId } = await setupWorkspaceMember(client)
      const dm = await insertStream(client, wsId, memberId, StreamTypes.DM)
      await insertMessages(client, dm.id, memberId, 5)
      await insertCompletedSession(client, dm.id, BigInt(4))

      // 0 clamps to 1: the window is the single newest message (sequence 5), and
      // the prior cursor (4) sits outside it → fresh. Without the clamp a 0
      // budget made findWindowFloorSequence return null → a spurious "continue"
      // into a zero-message window.
      const policy = await resolveContextWindowPolicy(client, { stream: dm, maxMessages: 0 })

      expect(policy).toEqual({ episode: { kind: "dm-recency", continues: false }, maxMessages: 1, carryDigests: false })
    })
  })
})
