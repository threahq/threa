import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { Querier } from "../../src/db"
import { AgentSessionStatuses, AgentStepTypes, DelegationStatuses } from "@threahq/types"
import { setupTestDatabase, withTestTransaction, withTransaction } from "./setup"
import { AgentSessionRepository, PersonaRepository } from "../../src/features/agents"
import { PersonaAttachmentRepository } from "../../src/features/agents/persona-attachment-repository"
import { AgentOutcomeReadRepository } from "../../src/features/agent-outcomes"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  agentFollowUpId,
  attachmentId,
  delegationId,
  eventId,
  messageId,
  personaId,
  sessionId,
  stepId,
  streamId,
  subagentRunId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id)

interface Scope {
  wsA: string
  wsB: string
  userA: string
  userB: string
  personaA: string
  personaB: string
}

describe("agent sessions, personas and outcomes workspace scope (INV-8)", () => {
  let pool: Pool
  let sequence = 0

  async function insertRow(table: string, row: Record<string, unknown>, db: Querier = pool) {
    const columns = Object.keys(row)
    await db.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    )
  }

  async function rawRows(table: string, rowIds: string[], column = "id") {
    const result = await pool.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1) ORDER BY ${column}`, [rowIds])
    return result.rows
  }

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Agents scope ${label}`,
        slug: `agents-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedScope(label: string): Promise<Scope> {
    const scope: Scope = {
      wsA: await seedWorkspace(`${label}-a`),
      wsB: await seedWorkspace(`${label}-b`),
      userA: userId(),
      userB: userId(),
      personaA: personaId(),
      personaB: personaId(),
    }
    await addPersona(scope.wsA, scope.personaA)
    await addPersona(scope.wsB, scope.personaB)
    return scope
  }

  async function addPersona(wid: string, id: string) {
    await insertRow("personas", {
      id,
      workspace_id: wid,
      slug: `scope-${id}`,
      name: `Persona ${id}`,
      model: "openrouter:anthropic/claude-sonnet-4.6",
      managed_by: "workspace",
    })
  }

  async function addStream(
    wid: string,
    creator: string,
    options: { visibility?: string; type?: string; rootStreamId?: string; parentAnchorId?: string } = {}
  ) {
    const id = streamId()
    await insertRow("streams", {
      id,
      workspace_id: wid,
      type: options.type ?? "channel",
      slug: `agents-scope-${id}`,
      visibility: options.visibility ?? "private",
      parent_stream_id: options.rootStreamId ?? null,
      root_stream_id: options.rootStreamId ?? null,
      parent_anchor_id: options.parentAnchorId ?? null,
      created_by: creator,
    })
    return id
  }

  async function addSession(
    wid: string,
    options: { streamId: string; personaId: string; status: string; triggerMessageId?: string } & Record<
      string,
      unknown
    >,
    db: Querier = pool
  ) {
    const { streamId: stream, personaId: persona, status, triggerMessageId, ...extra } = options
    const id = sessionId()
    await insertRow(
      "agent_sessions",
      {
        id,
        workspace_id: wid,
        stream_id: stream,
        persona_id: persona,
        trigger_message_id: triggerMessageId ?? messageId(),
        status,
        ...extra,
      },
      db
    )
    return id
  }

  async function addStep(
    wid: string,
    session: string,
    stepNumber: number,
    stepType: string,
    extra: Record<string, unknown> = {}
  ) {
    const id = stepId()
    await insertRow("agent_session_steps", {
      id,
      workspace_id: wid,
      session_id: session,
      step_number: stepNumber,
      step_type: stepType,
      ...extra,
    })
    return id
  }

  async function addEvent(wid: string, stream: string, eventType: string, payload: Record<string, unknown>) {
    const id = eventId()
    await insertRow("stream_events", {
      id,
      workspace_id: wid,
      stream_id: stream,
      sequence: ++sequence,
      event_type: eventType,
      payload: JSON.stringify(payload),
    })
    return id
  }

  async function addInvocation(
    wid: string,
    id: string,
    stream: string,
    status: string,
    extra: Record<string, unknown> = {},
    db: Querier = pool
  ) {
    await insertRow(
      "bot_invocations",
      {
        id,
        workspace_id: wid,
        root_stream_id: stream,
        active_stream_id: stream,
        source_message_id: messageId(),
        response_stream_id: stream,
        actor_type: "persona",
        actor_id: "persona_scope",
        trigger: "mention",
        required_capability: "scope",
        prompt_markdown: "prompt",
        author_user_id: "usr_scope",
        status,
        ...extra,
      },
      db
    )
  }

  async function addTask(
    wid: string,
    stream: string,
    options: { status?: string; createdAt?: Date; statusChangedAt?: Date; title?: string } & Record<
      string,
      unknown
    > = {}
  ) {
    const { status, createdAt, statusChangedAt, title, ...extra } = options
    const id = delegationId()
    await insertRow("delegated_tasks", {
      id,
      workspace_id: wid,
      stream_id: stream,
      created_by_kind: "persona",
      created_by_id: "persona_scope",
      title: title ?? `Task ${id}`,
      brief: "brief",
      status: status ?? DelegationStatuses.OPEN,
      created_at: createdAt ?? new Date(),
      status_changed_at: statusChangedAt ?? createdAt ?? new Date(),
      ...extra,
    })
    return id
  }

  async function addAttachment(wid: string) {
    const id = attachmentId()
    await insertRow("attachments", {
      id,
      workspace_id: wid,
      filename: `file-${id}.txt`,
      mime_type: "text/plain",
      size_bytes: 12,
      storage_path: `scope/${id}`,
      processing_status: "completed",
    })
    return id
  }

  async function addBinding(wid: string, persona: string, attachment: string, position: number) {
    await insertRow("persona_attachments", {
      attachment_id: attachment,
      workspace_id: wid,
      persona_id: persona,
      position,
      created_by: "usr_scope",
    })
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("session reads", () => {
    test("should treat only its own workspace's live claim as keeping a stale session alive", async () => {
      const orphans = await seedScope("orphans")
      const liveClaim = { claim_expires_at: new Date(Date.now() + 3_600_000) }
      // Uncommitted, so the preloaded server's orphan sweeper cannot fail these rows mid-test.
      const { seeded, expected, found } = await withTestTransaction(pool, async (client) => {
        const addStaleSession = async () => {
          const stream = await addStream(orphans.wsA, orphans.userA)
          const id = await addSession(
            orphans.wsA,
            {
              streamId: stream,
              personaId: orphans.personaA,
              status: AgentSessionStatuses.RUNNING,
              heartbeat_at: at(24 * 60),
            },
            client
          )
          return { id, stream }
        }
        const bare = await addStaleSession()
        // B's live claim under the id of A's stale session must not keep it from being swept.
        const withForeignClaim = await addStaleSession()
        await addInvocation(orphans.wsB, withForeignClaim.id, withForeignClaim.stream, "claimed", liveClaim, client)
        const withOwnClaim = await addStaleSession()
        await addInvocation(orphans.wsA, withOwnClaim.id, withOwnClaim.stream, "claimed", liveClaim, client)
        return {
          seeded: [bare.id, withForeignClaim.id, withOwnClaim.id],
          expected: [bare.id, withForeignClaim.id],
          found: ids(await AgentSessionRepository.findOrphaned(client, 60)),
        }
      })
      expect(found.filter((id) => seeded.includes(id)).toSorted()).toEqual(expected.toSorted())
    })
  })

  describe("session and step writes", () => {
    let scope: Scope
    let foreignRunning: string
    let foreignStep: string
    let ownClosing: string
    let ownCompleting: string
    let ownSteps: string
    let ownUpserts: string

    beforeAll(async () => {
      scope = await seedScope("session-writes")
      const { wsA, wsB, userA, userB, personaA, personaB } = scope

      foreignRunning = await addSession(wsB, {
        streamId: await addStream(wsB, userB),
        personaId: personaB,
        status: AgentSessionStatuses.RUNNING,
      })
      foreignStep = await addStep(wsB, foreignRunning, 1, AgentStepTypes.TOOL_CALL, {
        client_step_id: "b-client-step",
        started_at: at(20),
      })

      ownClosing = await addSession(wsA, {
        streamId: await addStream(wsA, userA),
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      ownCompleting = await addSession(wsA, {
        streamId: await addStream(wsA, userA),
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      for (const closing of [ownClosing, ownCompleting]) {
        await addStep(wsA, closing, 1, AgentStepTypes.TOOL_CALL)
        await addStep(wsB, closing, 7, AgentStepTypes.TOOL_CALL)
      }

      ownSteps = await addSession(wsA, {
        streamId: await addStream(wsA, userA),
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      await addStep(wsA, ownSteps, 1, AgentStepTypes.THINKING)
      await addStep(wsA, ownSteps, 2, AgentStepTypes.THINKING)
      await addStep(wsB, ownSteps, 10, AgentStepTypes.THINKING)

      ownUpserts = await addSession(wsA, {
        streamId: await addStream(wsA, userA),
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      await addStep(wsA, ownUpserts, 1, AgentStepTypes.THINKING, { content: JSON.stringify({ text: "attempt one" }) })
    })

    test("should leave another workspace's steps untouched when writing steps with a foreign session or step id", async () => {
      const { wsA } = scope
      const before = await rawRows("agent_session_steps", [foreignRunning], "session_id")

      const results = {
        updateStep: await AgentSessionRepository.updateStep(pool, wsA, foreignStep, { completedAt: new Date() }),
        finalize: await AgentSessionRepository.finalizeStepByClientStepId(pool, wsA, {
          sessionId: foreignRunning,
          clientStepId: "b-client-step",
          stepType: AgentStepTypes.TOOL_CALL,
          content: { leaked: true },
          completedAt: new Date(),
        }),
      }
      await expect(
        AgentSessionRepository.appendStep(pool, wsA, {
          id: stepId(),
          sessionId: foreignRunning,
          stepType: AgentStepTypes.THINKING,
          startedAt: new Date(),
        })
      ).rejects.toThrow(/row not found for session id/)
      // Step 1 already exists under B's session: the conflict arm must not overwrite it.
      await expect(
        AgentSessionRepository.upsertStep(pool, wsA, {
          id: stepId(),
          sessionId: foreignRunning,
          stepNumber: 1,
          stepType: AgentStepTypes.THINKING,
          content: { leaked: true },
          startedAt: new Date(),
        })
      ).rejects.toThrow(/row not found for session id/)

      expect({ results, rows: await rawRows("agent_session_steps", [foreignRunning], "session_id") }).toEqual({
        results: { updateStep: null, finalize: null },
        rows: before,
      })
    })

    test("should close only its own workspace's open steps when ending a session", async () => {
      const { wsA } = scope
      const closedByStatus = await AgentSessionRepository.updateStatus(
        pool,
        wsA,
        ownClosing,
        AgentSessionStatuses.COMPLETED
      )
      const closedByCompletion = await AgentSessionRepository.completeSession(pool, wsA, ownCompleting, {
        lastSeenSequence: 4n,
      })
      const openStepsBySession = async (session: string) =>
        Object.fromEntries(
          (await rawRows("agent_session_steps", [session], "session_id")).map((row) => [
            row.workspace_id,
            row.completed_at === null ? "open" : "closed",
          ])
        )

      expect({
        statuses: [closedByStatus?.status, closedByCompletion?.status],
        byStatus: await openStepsBySession(ownClosing),
        byCompletion: await openStepsBySession(ownCompleting),
      }).toEqual({
        statuses: [AgentSessionStatuses.COMPLETED, AgentSessionStatuses.COMPLETED],
        byStatus: { [scope.wsA]: "closed", [scope.wsB]: "open" },
        byCompletion: { [scope.wsA]: "closed", [scope.wsB]: "open" },
      })
    })

    test("should number appended steps from its own workspace's steps and dedup its own client step id", async () => {
      const { wsA } = scope
      const params = (clientStepId?: string) => ({
        id: stepId(),
        sessionId: ownSteps,
        stepType: AgentStepTypes.TOOL_CALL,
        startedAt: new Date(),
        clientStepId,
      })
      const first = await AgentSessionRepository.appendStep(pool, wsA, params("client-1"))
      const resent = await AgentSessionRepository.appendStep(pool, wsA, params("client-1"))
      const second = await AgentSessionRepository.appendStep(pool, wsA, params())

      expect({
        stepNumbers: [first.stepNumber, second.stepNumber],
        resentIsFirst: resent.id === first.id,
        stored: (await rawRows("agent_session_steps", [ownSteps], "session_id"))
          .sort((a, b) => a.step_number - b.step_number)
          .map((row) => [row.workspace_id === wsA ? "own" : "foreign", row.step_number]),
      }).toEqual({
        stepNumbers: [3, 4],
        resentIsFirst: true,
        stored: [
          ["own", 1],
          ["own", 2],
          ["own", 3],
          ["own", 4],
          ["foreign", 10],
        ],
      })
    })

    test("should upsert, update and finalize its own workspace's steps", async () => {
      const { wsA } = scope
      const upserted = await AgentSessionRepository.upsertStep(pool, wsA, {
        id: stepId(),
        sessionId: ownUpserts,
        stepNumber: 1,
        stepType: AgentStepTypes.TOOL_CALL,
        content: { text: "attempt two" },
        startedAt: new Date(),
      })
      const appended = await AgentSessionRepository.appendStep(pool, wsA, {
        id: stepId(),
        sessionId: ownUpserts,
        stepType: AgentStepTypes.TOOL_CALL,
        startedAt: new Date(),
        clientStepId: "finalize-me",
      })
      const updated = await AgentSessionRepository.updateStep(pool, wsA, appended.id, {
        messageId: "msg_step",
        sessionId: ownUpserts,
      })
      const finalized = await AgentSessionRepository.finalizeStepByClientStepId(pool, wsA, {
        sessionId: ownUpserts,
        clientStepId: "finalize-me",
        stepType: AgentStepTypes.TOOL_CALL,
        content: { done: true },
        completedAt: new Date(),
      })

      expect({
        upserted: { stepNumber: upserted.stepNumber, stepType: upserted.stepType, content: upserted.content },
        updated: updated?.messageId,
        finalized: { content: finalized?.content, completed: finalized?.completedAt instanceof Date },
      }).toEqual({
        upserted: { stepNumber: 1, stepType: AgentStepTypes.TOOL_CALL, content: { text: "attempt two" } },
        updated: "msg_step",
        finalized: { content: { done: true }, completed: true },
      })
    })
  })

  describe("personas and attachment bindings", () => {
    let scope: Scope
    let personaCapped: string
    let foreignCappedBinding: string

    beforeAll(async () => {
      scope = await seedScope("small-repos")
      const { wsA, wsB } = scope

      personaCapped = personaId()
      await addPersona(wsA, personaCapped)
      await addBinding(wsA, personaCapped, await addAttachment(wsA), 0)
      foreignCappedBinding = await addAttachment(wsB)
      await addBinding(wsB, personaCapped, foreignCappedBinding, 7)
    })

    test("should return system personas alongside its own workspace's personas", async () => {
      const { wsA, personaA, personaB } = scope
      const systemPersona = personaId()
      await insertRow("personas", {
        id: systemPersona,
        workspace_id: null,
        slug: `scope-${systemPersona}`,
        name: `System persona ${systemPersona}`,
        model: "openrouter:anthropic/claude-sonnet-4.6",
        managed_by: "system",
      })

      expect({
        one: (await PersonaRepository.findById(pool, wsA, systemPersona))?.id,
        many: (await PersonaRepository.findByIds(pool, wsA, [personaA, personaB, systemPersona]))
          .map((persona) => persona.id)
          .sort(),
      }).toEqual({ one: systemPersona, many: [personaA, systemPersona].sort() })
    })

    test("should bind and unbind attachments by counting only its own workspace's bindings", async () => {
      const { wsA, wsB } = scope
      const ownAttachment = await addAttachment(wsA)
      const binding = await withTransaction(pool, (client) =>
        PersonaAttachmentRepository.insertBinding(client, {
          attachmentId: ownAttachment,
          workspaceId: wsA,
          personaId: personaCapped,
          createdBy: "usr_scope",
          maxCount: 2,
        })
      )
      const unbindForeign = await PersonaAttachmentRepository.deleteBinding(
        pool,
        wsA,
        personaCapped,
        foreignCappedBinding
      )
      const unbindOwn = await PersonaAttachmentRepository.deleteBinding(pool, wsA, personaCapped, ownAttachment)

      expect({
        binding: binding && { workspaceId: binding.workspaceId, position: binding.position },
        unbindForeign,
        unbindOwn,
        foreignBindings: (await rawRows("persona_attachments", [foreignCappedBinding], "attachment_id")).map(
          (row) => row.workspace_id
        ),
      }).toEqual({
        binding: { workspaceId: wsA, position: 1 },
        unbindForeign: false,
        unbindOwn: true,
        foreignBindings: [wsB],
      })
    })
  })

  describe("agent outcomes", () => {
    let scope: Scope
    let expected: Array<{
      id: string
      kind: "delegation" | "follow_up" | "subagent"
      anchorEventId: string | null
      lastAgentMessageAt: string | null
    }>

    beforeAll(async () => {
      scope = await seedScope("outcomes")
      const { wsA, wsB, userA, userB, personaA, personaB } = scope
      const streamOwn = await addStream(wsA, userA, { visibility: "public" })
      const streamForeign = await addStream(wsB, userB, { visibility: "public" })

      const followUp = async (wid: string, stream: string, scheduledFor: Date) => {
        const id = agentFollowUpId()
        await insertRow("agent_follow_ups", {
          id,
          workspace_id: wid,
          stream_id: stream,
          persona_id: wid === wsA ? personaA : personaB,
          session_id: sessionId(),
          note: `Follow-up ${id}`,
          scheduled_for: scheduledFor,
          status_changed_at: scheduledFor,
        })
        return id
      }
      const subagent = async (wid: string, stream: string, changedAt: Date) => {
        const id = subagentRunId()
        await insertRow("subagent_runs", {
          id,
          workspace_id: wid,
          parent_stream_id: stream,
          scope_stream_id: streamId(),
          card_event_id: eventId(),
          thread_stream_id: streamId(),
          persona_id: wid === wsA ? personaA : personaB,
          model: "openrouter:anthropic/claude-sonnet-4.6",
          created_by: wid === wsA ? userA : userB,
          title: `Subagent ${id}`,
          brief: "brief",
          status_changed_at: changedAt,
        })
        return id
      }

      const delegationBare = await addTask(wsA, streamOwn, { statusChangedAt: at(60) })
      const delegationAnchored = await addTask(wsA, streamOwn, { statusChangedAt: at(50) })
      const delegationEvent = await addEvent(wsA, streamOwn, "delegation:created", { delegationId: delegationAnchored })
      const followUpBare = await followUp(wsA, streamOwn, at(40))
      const followUpAnchored = await followUp(wsA, streamOwn, at(35))
      const followUpEvent = await addEvent(wsA, streamOwn, "agent:follow_up_scheduled", {
        followUpId: followUpAnchored,
      })
      const subagentBare = await subagent(wsA, streamOwn, at(30))
      const subagentActive = await subagent(wsA, streamOwn, at(25))
      await addEvent(wsA, streamOwn, "subagent:status_changed", {
        subagentId: subagentActive,
        lastAgentMessageAt: "2026-01-01T00:00:00.000Z",
      })

      // B's rows under A's stream id, and B's anchor events for A's bare outcomes.
      await addTask(wsB, streamOwn, { statusChangedAt: at(55) })
      await followUp(wsB, streamOwn, at(45))
      await subagent(wsB, streamOwn, at(20))
      await addEvent(wsB, streamOwn, "delegation:created", { delegationId: delegationBare })
      await addEvent(wsB, streamOwn, "agent:follow_up_scheduled", { followUpId: followUpBare })
      await addEvent(wsB, streamOwn, "subagent:status_changed", {
        subagentId: subagentBare,
        lastAgentMessageAt: "2026-02-02T00:00:00.000Z",
      })
      // A's own rows pointing at B's stream.
      await addTask(wsA, streamForeign, { statusChangedAt: at(15) })

      expected = [
        { id: delegationBare, kind: "delegation", anchorEventId: null, lastAgentMessageAt: null },
        { id: delegationAnchored, kind: "delegation", anchorEventId: delegationEvent, lastAgentMessageAt: null },
        { id: followUpBare, kind: "follow_up", anchorEventId: null, lastAgentMessageAt: null },
        { id: followUpAnchored, kind: "follow_up", anchorEventId: followUpEvent, lastAgentMessageAt: null },
        { id: subagentBare, kind: "subagent", anchorEventId: expect.any(String), lastAgentMessageAt: null },
        {
          id: subagentActive,
          kind: "subagent",
          anchorEventId: expect.any(String),
          lastAgentMessageAt: "2026-01-01T00:00:00.000Z",
        },
      ]
    })

    test("should list only its own workspace's outcomes and anchors", async () => {
      const { wsA, userA } = scope
      const rows = await AgentOutcomeReadRepository.list(pool, {
        workspaceId: wsA,
        userId: userA,
        limit: 50,
        ascending: true,
      })

      expect(
        rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          anchorEventId: row.anchorEventId,
          lastAgentMessageAt: row.lastAgentMessageAt,
        }))
      ).toEqual(expected)
    })

    test("should count only its own workspace's outcomes", async () => {
      const { wsA, userA } = scope
      expect(await AgentOutcomeReadRepository.count(pool, { workspaceId: wsA, userId: userA })).toBe(expected.length)
    })
  })
})
