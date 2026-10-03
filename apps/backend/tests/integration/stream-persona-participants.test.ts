/**
 * Integration tests for stream persona participation tracking.
 *
 * Tests verify that:
 * 1. Persona participation is recorded when a persona sends a message
 * 2. Participation recording is idempotent (only first message creates record)
 * 3. Search can filter by persona participation
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Pool } from "pg"
import { EventService } from "../../src/features/messaging"
import { StreamPersonaParticipantRepository } from "../../src/features/agents"
import { SearchRepository } from "../../src/features/search"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId, personaId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent } from "./setup"
import { Visibilities } from "@threahq/types"

describe("Stream Persona Participants", () => {
  let pool: Pool
  let eventService: EventService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  beforeEach(async () => {
    // Clean up test data between tests
    await pool.query("DELETE FROM stream_persona_participants")
    await pool.query("DELETE FROM messages")
    await pool.query("DELETE FROM stream_events")
    await pool.query("DELETE FROM stream_sequences")
    await pool.query("DELETE FROM stream_members")
    await pool.query("DELETE FROM streams")
  })

  describe("Participation Recording", () => {
    test("should record participation when persona sends a message", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const testPersonaId = personaId()

      // Create a stream first
      await pool.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
         VALUES ($1, $2, 'scratchpad', 'private', $3)`,
        [testStreamId, testWorkspaceId, userId()]
      )

      // Send a message as persona
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testPersonaId,
        authorType: "persona",
        ...testMessageContent("Hello from persona!"),
      })

      // Verify participation was recorded
      const hasParticipated = await StreamPersonaParticipantRepository.hasParticipated(
        pool,
        testWorkspaceId,
        testStreamId,
        testPersonaId
      )
      expect(hasParticipated).toBe(true)
    })

    test("should NOT record participation for user messages", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const testUserId = userId()

      // Create a stream first
      await pool.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
         VALUES ($1, $2, 'scratchpad', 'private', $3)`,
        [testStreamId, testWorkspaceId, testUserId]
      )

      // Send a message as user
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("Hello from user!"),
      })

      // Verify NO participation was recorded
      const { rows } = await pool.query(`SELECT persona_id FROM stream_persona_participants WHERE stream_id = $1`, [
        testStreamId,
      ])
      expect(rows).toEqual([])
    })

    test("should be idempotent - multiple messages create only one record", async () => {
      const testStreamId = streamId()
      const testWorkspaceId = workspaceId()
      const testPersonaId = personaId()

      // Create a stream first
      await pool.query(
        `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
         VALUES ($1, $2, 'scratchpad', 'private', $3)`,
        [testStreamId, testWorkspaceId, userId()]
      )

      // Send multiple messages as the same persona
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testPersonaId,
        authorType: "persona",
        ...testMessageContent("First message"),
      })

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testPersonaId,
        authorType: "persona",
        ...testMessageContent("Second message"),
      })

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: testStreamId,
        authorId: testPersonaId,
        authorType: "persona",
        ...testMessageContent("Third message"),
      })

      // Verify only one participation record exists
      const { rows } = await pool.query(`SELECT persona_id FROM stream_persona_participants WHERE stream_id = $1`, [
        testStreamId,
      ])
      expect(rows).toEqual([{ persona_id: testPersonaId }])
    })
  })

  describe("Repository Queries", () => {
    test("should report participation per stream", async () => {
      const testWorkspaceId = workspaceId()
      const testPersonaId = personaId()
      const creatorId = userId()

      const stream1 = streamId()
      const stream2 = streamId()
      const stream3 = streamId()

      for (const sid of [stream1, stream2, stream3]) {
        await pool.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
           VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [sid, testWorkspaceId, creatorId]
        )
      }

      for (const sid of [stream1, stream2]) {
        await eventService.createMessage({
          workspaceId: testWorkspaceId,
          streamId: sid,
          authorId: testPersonaId,
          authorType: "persona",
          ...testMessageContent("Hello from persona"),
        })
      }

      const participated = await Promise.all(
        [stream1, stream2, stream3].map((sid) =>
          StreamPersonaParticipantRepository.hasParticipated(pool, testWorkspaceId, sid, testPersonaId)
        )
      )
      expect(participated).toEqual([true, true, false])
    })
  })

  describe("Search Integration", () => {
    test("should get accessible streams filtered by persona participation", async () => {
      const testWorkspaceId = workspaceId()
      const workosUserId = userId()
      const testPersonaId = personaId()

      // Create 2 streams - user is member of both
      const stream1 = streamId()
      const stream2 = streamId()
      await WorkspaceRepository.insert(pool, {
        id: testWorkspaceId,
        name: "Search Integration Workspace",
        slug: `search-integ-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      const testUserId = (await addTestMember(pool, testWorkspaceId, workosUserId)).id

      for (const sid of [stream1, stream2]) {
        await pool.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
           VALUES ($1, $2, 'scratchpad', 'private', $3)`,
          [sid, testWorkspaceId, testUserId]
        )
        await pool.query(`INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)`, [sid, testUserId])
      }

      // Persona only participates in stream1
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: testPersonaId,
        authorType: "persona",
        ...testMessageContent("Persona in stream 1"),
      })

      // User sends message in both streams (for search content)
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("User in stream 1"),
      })

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream2,
        authorId: testUserId,
        authorType: "user",
        ...testMessageContent("User in stream 2"),
      })

      // Get accessible streams with persona filter
      const streamsWithPersona = await SearchRepository.getAccessibleStreamsWithMembers(pool, {
        workspaceId: testWorkspaceId,
        userId: testUserId,
        userIds: [testPersonaId],
      })

      // Only stream1 should be returned (where persona participated)
      expect(streamsWithPersona).toHaveLength(1)
      expect(streamsWithPersona).toContain(stream1)
      expect(streamsWithPersona).not.toContain(stream2)
    })

    test("should handle mixed user and persona member IDs", async () => {
      const testWorkspaceId = workspaceId()
      const user1 = userId()
      const user2 = userId()
      const persona1 = personaId()
      let member1: string
      let member2: string

      // Create 3 streams
      const stream1 = streamId()
      const stream2 = streamId()
      const stream3 = streamId()
      await WorkspaceRepository.insert(pool, {
        id: testWorkspaceId,
        name: "Search Mixed Workspace",
        slug: `search-mixed-${testWorkspaceId}`,
        createdBy: user1,
      })
      member1 = (await addTestMember(pool, testWorkspaceId, user1)).id
      member2 = (await addTestMember(pool, testWorkspaceId, user2)).id

      for (const sid of [stream1, stream2, stream3]) {
        await pool.query(
          `INSERT INTO streams (id, workspace_id, type, visibility, created_by)
           VALUES ($1, $2, 'channel', '${Visibilities.PUBLIC}', $3)`,
          [sid, testWorkspaceId, member1]
        )
      }

      // User memberships:
      // stream1: user1, user2
      // stream2: user1
      // stream3: user1, user2
      await pool.query(`INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)`, [stream1, member1])
      await pool.query(`INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)`, [stream1, member2])
      await pool.query(`INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)`, [stream2, member1])
      await pool.query(`INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)`, [stream3, member1])
      await pool.query(`INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)`, [stream3, member2])

      // Persona participates in stream1 and stream2
      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream1,
        authorId: persona1,
        authorType: "persona",
        ...testMessageContent("Persona in stream 1"),
      })

      await eventService.createMessage({
        workspaceId: testWorkspaceId,
        streamId: stream2,
        authorId: persona1,
        authorType: "persona",
        ...testMessageContent("Persona in stream 2"),
      })

      // Filter for streams where user2 is member AND persona1 has participated
      const result = await SearchRepository.getAccessibleStreamsWithMembers(pool, {
        workspaceId: testWorkspaceId,
        userId: member1,
        userIds: [member2, persona1], // Mixed user + persona IDs
      })

      // Only stream1 matches: user2 is member AND persona1 participated
      // stream2: persona1 participated but user2 is NOT a member
      // stream3: user2 is member but persona1 did NOT participate
      expect(result).toHaveLength(1)
      expect(result).toContain(stream1)
    })
  })
})
