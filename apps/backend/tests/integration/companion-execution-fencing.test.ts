/**
 * A companion execution's durable writes are fenced to the generation it
 * claimed: once a takeover holds the session, the old execution's message and
 * trace writes commit nothing. Real Postgres, the real EventService and
 * TraceEmitter (INV-68).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import type { Server } from "socket.io"
import { AgentStepTypes, AuthorTypes } from "@threahq/types"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import {
  ARIADNE_AGENT_ID,
  AgentSessionRepository,
  CompanionExecutionLostError,
  PersonaAgent,
  SessionAbortRegistry,
  SessionStatuses,
  TraceEmitter,
  type CompanionExecutionRef,
  type PersonaAgentDeps,
} from "../../src/features/agents"
import { ORPHAN_SESSION_STALE_SECONDS } from "../../src/features/agents/orphan-session-cleanup"
import { messageId, sessionId, streamId, userId, workspaceId } from "../../src/lib/id"

const PERSONA = "persona_fenced"

let pool: Pool
let cleanup: () => Promise<void>
let eventService: EventService
let workspace: string
let member: string
let outsider: string

beforeAll(async () => {
  const isolated = await setupIsolatedTestDatabase("companion_execution_fencing")
  pool = isolated.pool
  cleanup = isolated.cleanup
  eventService = new EventService(pool)
  workspace = workspaceId()
  await withTransaction(pool, async (client) => {
    const creator = userId()
    await WorkspaceRepository.insert(client, { id: workspace, name: "Fencing", slug: workspace, createdBy: creator })
    member = (await addTestMember(client, workspace, creator)).id
    outsider = (await addTestMember(client, workspace, userId())).id
  })
}, 120_000)

afterAll(async () => cleanup(), 120_000)

async function seedRunningSession(): Promise<{ stream: string; gen1: CompanionExecutionRef }> {
  const stream = streamId()
  const id = sessionId()
  await withTransaction(pool, async (client) => {
    await StreamRepository.insert(client, {
      id: stream,
      workspaceId: workspace,
      type: "channel",
      visibility: "private",
      companionMode: "off",
      createdBy: member,
    })
    await StreamMemberRepository.insert(client, stream, member)
    await AgentSessionRepository.insertRunningOrSkip(client, {
      id,
      streamId: stream,
      personaId: PERSONA,
      triggerMessageId: messageId(),
      serverId: "server_gen1",
      initialSequence: BigInt(0),
      initiatingUserId: member,
    })
  })
  return { stream, gen1: { sessionId: id, generation: 1 } }
}

/** Orphan-style takeover: fail generation 1 and claim generation 2, left uncommitted on `client`. */
async function takeOver(client: PoolClient, gen1: CompanionExecutionRef): Promise<CompanionExecutionRef> {
  await client.query("BEGIN")
  await AgentSessionRepository.failExecution(client, gen1.sessionId, { generation: gen1.generation, error: "stale" })
  const claimed = await AgentSessionRepository.claimExecution(client, gen1.sessionId, {
    serverId: "server_gen2",
    staleThresholdSeconds: ORPHAN_SESSION_STALE_SECONDS,
  })
  return { sessionId: gen1.sessionId, generation: claimed!.executionGeneration }
}

async function committedTakeover(gen1: CompanionExecutionRef): Promise<CompanionExecutionRef> {
  const client = await pool.connect()
  try {
    const gen2 = await takeOver(client, gen1)
    await client.query("COMMIT")
    return gen2
  } finally {
    client.release()
  }
}

function send(stream: string, text: string, execution?: CompanionExecutionRef, initiatingUserId = member) {
  return eventService.createGeneratedMessage(
    { kind: "user", userId: initiatingUserId },
    {
      workspaceId: workspace,
      streamId: stream,
      authorId: PERSONA,
      authorType: AuthorTypes.PERSONA,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      contentMarkdown: text,
    },
    execution
  )
}

function edit(stream: string, id: string, text: string, execution: CompanionExecutionRef) {
  return eventService.editGeneratedMessage(
    { kind: "user", userId: member },
    {
      workspaceId: workspace,
      streamId: stream,
      messageId: id,
      actorId: PERSONA,
      actorType: AuthorTypes.PERSONA,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      contentMarkdown: text,
    },
    execution
  )
}

function remove(stream: string, id: string, execution: CompanionExecutionRef) {
  return eventService.deleteGeneratedMessage(
    { kind: "user", userId: member },
    { workspaceId: workspace, streamId: stream, messageId: id, actorId: PERSONA, actorType: AuthorTypes.PERSONA },
    execution
  )
}

async function streamWrites(stream: string) {
  const result = await pool.query<{ messages: string[]; events: string[]; outbox: string[] }>(
    `SELECT
       ARRAY(SELECT content_markdown || ':' || (deleted_at IS NOT NULL) FROM messages WHERE stream_id = $1 ORDER BY created_at) messages,
       ARRAY(SELECT event_type FROM stream_events WHERE stream_id = $1 ORDER BY sequence) events,
       ARRAY(SELECT event_type FROM outbox WHERE payload->>'streamId' = $1 ORDER BY id) outbox`,
    [stream]
  )
  return result.rows[0]!
}

function silentIo(): Server {
  const target = { to: () => target, emit: () => true }
  return target as unknown as Server
}

function traceFor(stream: string, execution: CompanionExecutionRef) {
  return new TraceEmitter({ io: silentIo(), pool }).forSession({
    sessionId: execution.sessionId,
    workspaceId: workspace,
    streamId: stream,
    triggerMessageId: "msg_trigger",
    personaName: "Fenced",
    executionGeneration: execution.generation,
  })
}

async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const waiting = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
    )
    if ((waiting.rowCount ?? 0) > 0) return
    await Bun.sleep(10)
  }
  throw new Error("write never waited on the session lock")
}

describe("companion execution fencing", () => {
  test("a create waiting behind a takeover commits nothing; the new owner's create lands", async () => {
    const { stream, gen1 } = await seedRunningSession()
    const before = await streamWrites(stream)

    const takeover = await pool.connect()
    let gen2: CompanionExecutionRef
    try {
      gen2 = await takeOver(takeover, gen1)
      const stale = send(stream, "stale reply", gen1).then(
        () => null,
        (err: unknown) => err
      )
      await waitForLockWait()
      await takeover.query("COMMIT")
      expect(await stale).toBeInstanceOf(CompanionExecutionLostError)
    } finally {
      takeover.release()
    }

    expect(await streamWrites(stream)).toEqual(before)

    await send(stream, "current reply", gen2)
    const after = await streamWrites(stream)
    expect(after.messages).toEqual(["current reply:false"])
    expect(after.events).toEqual([...before.events, "message_created"])
  })

  test("after a takeover the old execution cannot edit or delete, and edit never creates", async () => {
    const { stream, gen1 } = await seedRunningSession()
    const original = await send(stream, "first answer", gen1)
    const gen2 = await committedTakeover(gen1)
    const before = await streamWrites(stream)

    await expect(edit(stream, original.id, "stale revision", gen1)).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(remove(stream, original.id, gen1)).rejects.toBeInstanceOf(CompanionExecutionLostError)
    expect(await streamWrites(stream)).toEqual(before)

    const revised = await edit(stream, original.id, "current revision", gen2)
    expect(revised?.id).toBe(original.id)
    expect((await MessageRepository.findById(pool, original.id))?.contentMarkdown).toBe("current revision")
    await remove(stream, original.id, gen2)
    expect((await streamWrites(stream)).messages).toEqual(["current revision:true"])
  })

  test("a stale trace handle cannot start, finish or annotate steps over the replacement's trace", async () => {
    const { stream, gen1 } = await seedRunningSession()
    const oldTrace = traceFor(stream, gen1)
    const oldStep = await oldTrace.startStep({ stepType: AgentStepTypes.THINKING, content: "gen1 thinking" })

    const gen2 = await committedTakeover(gen1)
    const newTrace = traceFor(stream, gen2)
    const newStep = await newTrace.startStep({ stepType: AgentStepTypes.WEB_SEARCH, content: "gen2 search" })

    await expect(oldTrace.startStep({ stepType: AgentStepTypes.TOOL_CALL })).rejects.toBeInstanceOf(
      CompanionExecutionLostError
    )
    await expect(oldStep.complete({ content: "gen1 fabricated" })).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(oldStep.verify({ status: "approved" })).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(oldStep.effects([])).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await oldStep.updateSubsteps([{ text: "gen1 phase", at: new Date().toISOString() }])
    expect(await AgentSessionRepository.updateLastSeenSequence(pool, gen1, BigInt(99))).toBe(false)
    expect(await AgentSessionRepository.updateContextMessageIds(pool, gen1, ["msg_stale"])).toBe(false)

    const steps = await AgentSessionRepository.findStepsBySession(pool, gen1.sessionId)
    expect(
      steps.map((s) => ({ stepNumber: s.stepNumber, stepType: s.stepType, content: s.content, done: !!s.completedAt }))
    ).toEqual([{ stepNumber: 1, stepType: AgentStepTypes.WEB_SEARCH, content: "gen2 search", done: false }])
    const session = await AgentSessionRepository.findById(pool, gen1.sessionId)
    expect({
      currentStepType: session?.currentStepType,
      lastSeenSequence: session?.lastSeenSequence,
      contextMessageIds: session?.contextMessageIds,
    }).toEqual({ currentStepType: AgentStepTypes.WEB_SEARCH, lastSeenSequence: BigInt(0), contextMessageIds: [] })

    await newStep.complete({ content: "gen2 done" })
    expect(await AgentSessionRepository.updateLastSeenSequence(pool, gen2, BigInt(7))).toBe(true)
    const [finished] = await AgentSessionRepository.findStepsBySession(pool, gen1.sessionId)
    expect({ content: finished!.content, done: !!finished!.completedAt }).toEqual({ content: "gen2 done", done: true })
  })

  test("a held execution authorizes only its own stream, persona and sponsor, never stream authority", async () => {
    const { stream, gen1 } = await seedRunningSession()
    const { stream: otherStream } = await seedRunningSession()

    await expect(send(stream, "outsider", gen1, outsider)).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(send(otherStream, "another stream", gen1)).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(
      send(stream, "wrong generation", { sessionId: gen1.sessionId, generation: gen1.generation + 5 })
    ).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(
      eventService.createGeneratedMessage(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: stream,
          authorId: "persona_other",
          authorType: AuthorTypes.PERSONA,
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
          contentMarkdown: "wrong persona",
        },
        gen1
      )
    ).rejects.toBeInstanceOf(CompanionExecutionLostError)
    const own = await send(stream, "own write", gen1)
    await expect(
      eventService.editGeneratedMessage(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: otherStream,
          messageId: own.id,
          actorId: PERSONA,
          actorType: "persona",
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "y" }] }] },
          contentMarkdown: "edited via another stream",
        },
        gen1
      )
    ).rejects.toBeInstanceOf(CompanionExecutionLostError)
    await expect(
      eventService.deleteGeneratedMessage(
        { kind: "user", userId: outsider },
        { workspaceId: workspace, streamId: stream, messageId: own.id, actorId: PERSONA, actorType: "persona" },
        gen1
      )
    ).rejects.toBeInstanceOf(CompanionExecutionLostError)

    await StreamMemberRepository.delete(pool, stream, member)
    await expect(send(stream, "sponsor lost access", gen1)).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" })

    expect({ own: await streamWrites(stream), other: (await streamWrites(otherStream)).messages }).toMatchObject({
      own: { messages: ["own write:false"] },
      other: [],
    })

    await send(otherStream, "bot-style generated write")
    expect((await streamWrites(otherStream)).messages).toEqual(["bot-style generated write:false"])
  })
})

interface Frame {
  rooms: string[]
  event: string
  payload: Record<string, unknown>
}

function recordingIo(frames: Frame[]): Server {
  const target = (rooms: string[]) => ({
    to: (room: string) => target([...rooms, room]),
    emit: (event: string, payload: Record<string, unknown>) => {
      frames.push({ rooms, event, payload })
      return true
    },
  })
  return { to: (room: string) => target([room]) } as unknown as Server
}

describe("companion notifications after a replacement claim", () => {
  test.each([
    { name: "retryable failure", attempt: 0, maxAttempts: 3 },
    { name: "terminal failure", attempt: undefined, maxAttempts: undefined },
  ])(
    "$name: the replaced execution's post-commit frames carry its own generation",
    async ({ attempt, maxAttempts }) => {
      const channel = streamId()
      const thread = streamId()
      const anchor = messageId()
      const trigger = messageId()
      await withTransaction(pool, async (client) => {
        for (const stream of [
          { id: channel, type: "channel" as const },
          {
            id: thread,
            type: "thread" as const,
            parentStreamId: channel,
            parentAnchorId: anchor,
            rootStreamId: channel,
          },
        ]) {
          await StreamRepository.insert(client, {
            workspaceId: workspace,
            visibility: "private",
            companionMode: "off",
            createdBy: member,
            ...stream,
          })
        }
        await StreamMemberRepository.insert(client, channel, member)
      })

      const frames: Frame[] = []
      const io = recordingIo(frames)
      const traceEmitter = new TraceEmitter({ io, pool })

      // Arm on the connection that commits the old execution's failure; right after
      // that COMMIT (before PersonaAgent emits anything) a replacement claims the
      // FAILED row as generation 2 and announces itself.
      const failureClients = new WeakSet<object>()
      const failExecution = AgentSessionRepository.failExecution.bind(AgentSessionRepository)
      const failSpy = spyOn(AgentSessionRepository, "failExecution").mockImplementation(async (db, id, params) => {
        failureClients.add(db)
        return failExecution(db, id, params)
      })
      let claimedGeneration: number | null = null
      const claimAndAnnounce = async () => {
        const session = (await AgentSessionRepository.listByTriggerMessage(pool, trigger))[0]!
        const claimed = await withTransaction(pool, (tx) =>
          AgentSessionRepository.claimExecution(tx, session.id, {
            serverId: "server_gen2",
            staleThresholdSeconds: ORPHAN_SESSION_STALE_SECONDS,
          })
        )
        claimedGeneration = claimed!.executionGeneration
        traceEmitter
          .forSession({
            sessionId: session.id,
            executionGeneration: claimedGeneration,
            workspaceId: workspace,
            streamId: thread,
            triggerMessageId: trigger,
            personaName: "Ariadne",
            parentStreamId: channel,
            parentMessageId: anchor,
          })
          .notifyActivityStarted()
      }
      const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown
      const connectSpy = spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
        // pool.query checks out through the callback form; only transactions use the promise form.
        if (args.length > 0) return connect(...args)
        return (connect() as Promise<PoolClient>).then((client) => {
          const query = client.query
          client.query = (async (text: unknown, ...rest: unknown[]) => {
            const result = await (query as (...a: unknown[]) => Promise<unknown>).call(client, text, ...rest)
            if (text === "COMMIT" && failureClients.has(client) && claimedGeneration === null) {
              await claimAndAnnounce()
            }
            return result
          }) as PoolClient["query"]
          const release = client.release
          client.release = ((err?: Error | boolean) => {
            client.query = query
            client.release = release
            return release.call(client, err)
          }) as PoolClient["release"]
          return client
        })
      }) as never)

      try {
        const agent = new PersonaAgent({
          pool,
          traceEmitter,
          sessionAbortRegistry: new SessionAbortRegistry(),
          assertInitiatorWritable: async () => {
            throw new Error("provider exploded")
          },
        } as unknown as PersonaAgentDeps)
        const result = await agent.run({
          workspaceId: workspace,
          streamId: thread,
          messageId: trigger,
          personaId: ARIADNE_AGENT_ID,
          serverId: "server_gen1",
          initiatingUserId: member,
          purpose: { kind: "mention" },
          attempt,
          maxAttempts,
        })
        expect(result.status).toBe("failed")
      } finally {
        connectSpy.mockRestore()
        failSpy.mockRestore()
      }

      const session = (await AgentSessionRepository.listByTriggerMessage(pool, trigger))[0]!
      expect({ status: session.status, generation: session.executionGeneration }).toEqual({
        status: SessionStatuses.RUNNING,
        generation: 2,
      })
      const terminal = attempt === undefined
      expect(frames.map((f) => ({ event: f.event, generation: f.payload.executionGeneration }))).toEqual([
        { event: "agent_session:activity_started", generation: 1 },
        { event: "agent_session:activity_started", generation: 2 },
        ...(terminal ? [{ event: "agent_session:failed", generation: 1 }] : []),
        { event: "agent_session:activity_ended", generation: 1 },
      ])
    }
  )
})
