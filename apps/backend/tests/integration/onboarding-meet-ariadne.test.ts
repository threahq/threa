/**
 * "Meet Ariadne" onboarding against the real schema (INV-68): the partial unique
 * index on `streams.uniqueness_key` makes the find-or-create race-safe, and the
 * greeting job is enqueued only by the call that minted the stream.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { Pool } from "pg"
import { CompanionModes } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { StreamMemberRepository } from "../../src/features/streams/member-repository"
import { OnboardingService } from "../../src/features/onboarding"
import { onboardingStreamUniquenessKey } from "../../src/features/streams"
import { ARIADNE_AGENT_ID, PersonaRepository, resolveTurnPurpose } from "../../src/features/agents"
import { JobQueues } from "../../src/lib/queue"
import { userId, workspaceId } from "../../src/lib/id"

describe("meet ariadne onboarding", () => {
  let pool: Pool
  let service: OnboardingService
  let wsId: string
  let newUser: string
  let otherUser: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new OnboardingService({ pool, streamService: new StreamService(pool) })
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      newUser = (await addTestMember(client, wsId, userId())).id
      otherUser = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Meet Ariadne Workspace",
        slug: `meet-ariadne-${wsId.toLowerCase()}`,
        createdBy: newUser,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function greetingJobs(streamId: string) {
    const result = await pool.query(
      "SELECT payload FROM queue_messages WHERE workspace_id = $1 AND queue_name = $2 AND payload->>'streamId' = $3",
      [wsId, JobQueues.PERSONA_AGENT, streamId]
    )
    return result.rows.map((row) => row.payload)
  }

  test("should create one Ariadne scratchpad and one greeting job when the user meets Ariadne", async () => {
    const { streamId } = await service.meetAriadne({ workspaceId: wsId, userId: newUser })

    const streams = await pool.query(
      "SELECT type, created_by, companion_mode, companion_persona_id, uniqueness_key FROM streams WHERE workspace_id = $1 AND uniqueness_key = $2",
      [wsId, onboardingStreamUniquenessKey(newUser)]
    )
    expect(streams.rows).toEqual([
      {
        type: "scratchpad",
        created_by: newUser,
        companion_mode: CompanionModes.ON,
        companion_persona_id: ARIADNE_AGENT_ID,
        uniqueness_key: onboardingStreamUniquenessKey(newUser),
      },
    ])
    const members = await StreamMemberRepository.list(pool, { streamId })
    expect(members.map((member) => member.memberId)).toEqual([newUser])

    const jobs = await greetingJobs(streamId)
    expect(jobs).toEqual([
      {
        workspaceId: wsId,
        streamId,
        messageId: expect.stringMatching(/^greeting_/),
        personaId: ARIADNE_AGENT_ID,
        triggeredBy: newUser,
        onboardingGreeting: true,
      },
    ])
    expect(resolveTurnPurpose(jobs[0])).toEqual({ kind: "onboarding_greeting" })

    const created = await pool.query(
      "SELECT payload->>'onboarding' AS onboarding FROM outbox WHERE event_type = 'stream:created' AND payload->>'streamId' = $1",
      [streamId]
    )
    expect(created.rows).toEqual([{ onboarding: "true" }])
  })

  test("should return the same stream and enqueue no second job when the user meets Ariadne again, even concurrently", async () => {
    const first = await service.meetAriadne({ workspaceId: wsId, userId: otherUser })
    const [second, third] = await Promise.all([
      service.meetAriadne({ workspaceId: wsId, userId: otherUser }),
      service.meetAriadne({ workspaceId: wsId, userId: otherUser }),
    ])

    expect([second, third]).toEqual([first, first])
    expect(await greetingJobs(first.streamId)).toHaveLength(1)
  })

  test("should enqueue exactly one job when the first calls race", async () => {
    const racer = (await withTransaction(pool, (client) => addTestMember(client, wsId, userId()))).id

    const results = await Promise.all([
      service.meetAriadne({ workspaceId: wsId, userId: racer }),
      service.meetAriadne({ workspaceId: wsId, userId: racer }),
      service.meetAriadne({ workspaceId: wsId, userId: racer }),
    ])

    const ids = new Set(results.map((result) => result.streamId))
    expect([...ids]).toHaveLength(1)
    expect(await greetingJobs([...ids][0]!)).toHaveLength(1)
  })

  test("should report onboardingStreamId for the user who met Ariadne and null for others", async () => {
    const stranger = (await withTransaction(pool, (client) => addTestMember(client, wsId, userId()))).id
    const { streamId } = await service.meetAriadne({ workspaceId: wsId, userId: newUser })

    expect(await service.findMeetAriadneStreamId(wsId, newUser)).toBe(streamId)
    expect(await service.findMeetAriadneStreamId(wsId, stranger)).toBeNull()
  })

  test("should fail with ARIADNE_PERSONA_MISSING and create nothing when Ariadne is unavailable", async () => {
    const lonely = (await withTransaction(pool, (client) => addTestMember(client, wsId, userId()))).id
    const spy = spyOn(PersonaRepository, "getSystemDefault").mockResolvedValueOnce(null)

    try {
      await expect(service.meetAriadne({ workspaceId: wsId, userId: lonely })).rejects.toMatchObject({
        status: 503,
        code: "ARIADNE_PERSONA_MISSING",
      })
    } finally {
      spy.mockRestore()
    }
    expect(await service.findMeetAriadneStreamId(wsId, lonely)).toBeNull()
  })
})
