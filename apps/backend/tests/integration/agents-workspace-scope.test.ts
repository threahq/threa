import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import type { Querier } from "../../src/db"
import { AgentSessionStatuses, AgentStepTypes, DelegationStatuses } from "@threahq/types"
import { setupTestDatabase, withTestTransaction, withTransaction } from "./setup"
import {
  AgentSessionRepository,
  ConversationSummaryRepository,
  PersonaRepository,
  StreamPersonaParticipantRepository,
} from "../../src/features/agents"
import { PersonaAttachmentRepository } from "../../src/features/agents/persona-attachment-repository"
import { AgentOutcomeReadRepository } from "../../src/features/agent-outcomes"
import { DelegatedTaskRepository } from "../../src/features/delegations"
import { WorkspaceRepository } from "../../src/features/workspaces"
import {
  agentConversationSummaryId,
  agentFollowUpId,
  attachmentId,
  delegationId,
  eventId,
  extractionId,
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

describe("agent sessions, personas, outcomes and delegations workspace scope (INV-8)", () => {
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

  async function addExtraction(wid: string, attachment: string, summary: string, fullText: string | null) {
    await insertRow("attachment_extractions", {
      id: extractionId(),
      workspace_id: wid,
      attachment_id: attachment,
      content_type: "document",
      summary,
      full_text: fullText,
    })
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
    let scope: Scope
    let streamHistory: string
    let triggerHistory: string
    let sessionOld: string
    let sessionNew: string
    let decoyHistory: string
    let digestStep: string
    let thinkingStep: string
    let streamRun: string
    let streamRunB: string
    let sessionRun: string
    let sessionRunB: string
    let sessionThread: string
    let sessionCrossPointer: string
    let threadStream: string
    let threadAnchor: string
    let createdNew: Date
    let completedNew: Date

    beforeAll(async () => {
      scope = await seedScope("session-reads")
      const { wsA, wsB, userA, userB, personaA, personaB } = scope

      streamHistory = await addStream(wsA, userA)
      triggerHistory = messageId()
      createdNew = at(120)
      completedNew = at(119)
      sessionOld = await addSession(wsA, {
        streamId: streamHistory,
        personaId: personaA,
        status: AgentSessionStatuses.COMPLETED,
        triggerMessageId: triggerHistory,
        created_at: at(180),
        completed_at: at(179),
      })
      sessionNew = await addSession(wsA, {
        streamId: streamHistory,
        personaId: personaA,
        status: AgentSessionStatuses.COMPLETED,
        triggerMessageId: triggerHistory,
        created_at: createdNew,
        completed_at: completedNew,
        episode_summary: "A episode",
      })
      // Newest session of the stream, persona and trigger, owned by B: every unpinned read prefers it.
      decoyHistory = await addSession(wsB, {
        streamId: streamHistory,
        personaId: personaA,
        status: AgentSessionStatuses.COMPLETED,
        triggerMessageId: triggerHistory,
        created_at: at(10),
        completed_at: at(9),
        episode_summary: "B secret episode",
      })
      digestStep = await addStep(wsA, sessionNew, 1, AgentStepTypes.TURN_DIGEST, {
        content: JSON.stringify({ findings: "A digest" }),
      })
      thinkingStep = await addStep(wsA, sessionNew, 2, AgentStepTypes.THINKING)
      await addStep(wsB, sessionNew, 3, AgentStepTypes.TURN_DIGEST, {
        content: JSON.stringify({ findings: "B secret digest" }),
      })
      await addStep(wsB, decoyHistory, 1, AgentStepTypes.TURN_DIGEST)

      streamRun = await addStream(wsA, userA)
      streamRunB = await addStream(wsB, userB)
      sessionRun = await addSession(wsA, {
        streamId: streamRun,
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
        sent_message_ids: [messageId()],
        current_step_type: AgentStepTypes.THINKING,
      })
      await addStep(wsA, sessionRun, 1, AgentStepTypes.MESSAGE_SENT)
      await addStep(wsA, sessionRun, 2, AgentStepTypes.TOOL_CALL)
      await addStep(wsB, sessionRun, 9, AgentStepTypes.MESSAGE_SENT)
      sessionRunB = await addSession(wsB, {
        streamId: streamRunB,
        personaId: personaB,
        status: AgentSessionStatuses.RUNNING,
      })
      await addStep(wsB, sessionRunB, 1, AgentStepTypes.MESSAGE_SENT)

      threadAnchor = eventId()
      threadStream = await addStream(wsA, userA, {
        type: "thread",
        rootStreamId: streamRun,
        parentAnchorId: threadAnchor,
      })
      sessionThread = await addSession(wsA, {
        streamId: threadStream,
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      // An A session pointing at B's stream: only the join pin keeps it out of A's sidebar seed.
      sessionCrossPointer = await addSession(wsA, {
        streamId: await addStream(wsB, userB),
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
    })

    test("should find a session by id only inside its own workspace", async () => {
      const { wsA } = scope
      expect({
        own: (await AgentSessionRepository.findById(pool, wsA, sessionNew))?.id,
        foreign: await AgentSessionRepository.findById(pool, wsA, decoyHistory),
        ownLocked: (await AgentSessionRepository.findByIdForUpdate(pool, wsA, sessionNew))?.id,
        foreignLocked: await AgentSessionRepository.findByIdForUpdate(pool, wsA, decoyHistory),
      }).toEqual({ own: sessionNew, foreign: null, ownLocked: sessionNew, foreignLocked: null })
    })

    test("should return only its own workspace's sessions when reading by trigger message", async () => {
      const { wsA } = scope
      expect({
        latest: (await AgentSessionRepository.findByTriggerMessage(pool, wsA, triggerHistory))?.id,
        all: ids(await AgentSessionRepository.listByTriggerMessage(pool, wsA, triggerHistory)),
      }).toEqual({ latest: sessionNew, all: [sessionNew, sessionOld] })
    })

    test("should return only its own workspace's latest session when reading a stream's history", async () => {
      const { wsA } = scope
      expect({
        latest: (await AgentSessionRepository.findLatestByStream(pool, wsA, streamHistory))?.id,
        latestCompleted: (await AgentSessionRepository.findLatestCompletedByStream(pool, wsA, streamHistory))?.id,
      }).toEqual({ latest: sessionNew, latestCompleted: sessionNew })
    })

    test("should read digests, episode summaries and steps only from its own workspace", async () => {
      const { wsA, personaA } = scope
      const params = { streamId: streamHistory, personaId: personaA, limit: 10 }
      expect({
        digests: (await AgentSessionRepository.findRecentDigestStepsByStream(pool, wsA, params)).map(
          (digest) => digest.step.id
        ),
        episodes: await AgentSessionRepository.findRecentEpisodeSummariesByStream(pool, wsA, params),
        steps: (await AgentSessionRepository.findStepsBySession(pool, wsA, sessionNew)).map((step) => step.id),
      }).toEqual({
        digests: [digestStep],
        episodes: [
          {
            summary: "A episode",
            sessionCreatedAt: createdNew,
            sessionCompletedAt: completedNew,
            turnDigests: [{ findings: "A digest" }],
          },
        ],
        steps: [digestStep, thinkingStep],
      })
    })

    test("should count only its own workspace's steps when summarizing running sessions", async () => {
      const { wsA } = scope
      const snapshots = await AgentSessionRepository.findProgressSnapshotsByIds(pool, wsA, [sessionRun, sessionRunB])
      const counts = await AgentSessionRepository.countStepsBySessions(pool, wsA, [sessionRun, sessionRunB])
      expect({ snapshots: Object.fromEntries(snapshots), counts: Object.fromEntries(counts) }).toEqual({
        snapshots: {
          [sessionRun]: {
            sessionId: sessionRun,
            currentStepType: AgentStepTypes.THINKING,
            stepCount: 2,
            messageCount: 1,
          },
        },
        counts: { [sessionRun]: { stepCount: 2, messageCount: 1 } },
      })
    })

    test("should find running sessions only inside its own workspace", async () => {
      const { wsA } = scope
      expect({
        own: (await AgentSessionRepository.findRunningByStream(pool, wsA, streamRun))?.id,
        foreign: await AgentSessionRepository.findRunningByStream(pool, wsA, streamRunB),
        many: ids(await AgentSessionRepository.findRunningByStreams(pool, wsA, [streamRun, streamRunB])),
      }).toEqual({ own: sessionRun, foreign: null, many: [sessionRun] })
    })

    test("should list running sessions of its own workspace only when seeding the sidebar", async () => {
      const { wsA, personaA } = scope
      const running = await AgentSessionRepository.listRunningByWorkspace(pool, wsA)
      expect(running.toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual(
        [
          {
            sessionId: sessionRun,
            streamId: streamRun,
            rootStreamId: streamRun,
            parentAnchorId: null,
            triggerMessageId: expect.any(String),
            personaId: personaA,
            startedAt: expect.any(Date),
            currentStepType: AgentStepTypes.THINKING,
          },
          {
            sessionId: sessionThread,
            streamId: threadStream,
            rootStreamId: streamRun,
            parentAnchorId: threadAnchor,
            triggerMessageId: expect.any(String),
            personaId: personaA,
            startedAt: expect.any(Date),
            currentStepType: null,
          },
        ].toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))
      )
      expect(running.map((row) => row.sessionId)).not.toContain(sessionCrossPointer)
    })

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
    let streamForeign: string
    let foreignRunning: string
    let foreignCaptured: string
    let foreignStep: string
    let ownRunning: string
    let ownClosing: string
    let ownCompleting: string
    let ownSteps: string
    let ownUpserts: string
    let ownInvocation: string
    let crossInvocation: string
    let crossSession: string
    let foreignInvocation: string
    let foreignInvocationStream: string

    const foreignRunningInitial = {
      heartbeat_at: null,
      current_step_type: null,
      context_message_ids: [] as string[],
      episode_summary: null,
      reflective_captured_at: null,
      response_validation_failed: false,
      last_seen_sequence: null,
      abort_requested_at: null,
    }

    beforeAll(async () => {
      scope = await seedScope("session-writes")
      const { wsA, wsB, userA, userB, personaA, personaB } = scope

      streamForeign = await addStream(wsB, userB)
      foreignRunning = await addSession(wsB, {
        streamId: streamForeign,
        personaId: personaB,
        status: AgentSessionStatuses.RUNNING,
        ...foreignRunningInitial,
      })
      foreignCaptured = await addSession(wsB, {
        streamId: await addStream(wsB, userB),
        personaId: personaB,
        status: AgentSessionStatuses.COMPLETED,
        completed_at: at(60),
        reflective_captured_at: at(30),
      })
      foreignStep = await addStep(wsB, foreignRunning, 1, AgentStepTypes.TOOL_CALL, {
        client_step_id: "b-client-step",
        started_at: at(20),
      })

      ownRunning = await addSession(wsA, {
        streamId: await addStream(wsA, userA),
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
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

      foreignInvocationStream = await addStream(wsB, userB)
      foreignInvocation = await addSession(wsB, {
        streamId: foreignInvocationStream,
        personaId: personaB,
        status: AgentSessionStatuses.RUNNING,
      })
      await addInvocation(wsB, foreignInvocation, foreignInvocationStream, "claimed")

      const ownInvocationStream = await addStream(wsA, userA)
      ownInvocation = await addSession(wsA, {
        streamId: ownInvocationStream,
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      await addInvocation(wsA, ownInvocation, ownInvocationStream, "claimed")

      // Same id as A's session, but the invocation row belongs to B.
      const crossStream = await addStream(wsA, userA)
      crossInvocation = await addSession(wsA, {
        streamId: crossStream,
        personaId: personaA,
        status: AgentSessionStatuses.RUNNING,
      })
      await addInvocation(wsB, crossInvocation, crossStream, "claimed")

      // Same id again, the other way round: the session belongs to B, the invocation to A.
      const crossSessionStream = await addStream(wsB, userB)
      crossSession = await addSession(wsB, {
        streamId: crossSessionStream,
        personaId: personaB,
        status: AgentSessionStatuses.RUNNING,
      })
      await addInvocation(wsA, crossSession, crossSessionStream, "claimed")
    })

    test("should leave another workspace's session untouched when writing with a foreign id", async () => {
      const { wsA } = scope
      const tracked = [foreignRunning, foreignCaptured]
      const before = await rawRows("agent_sessions", tracked)

      const results = {
        updateStatus: await AgentSessionRepository.updateStatus(
          pool,
          wsA,
          foreignRunning,
          AgentSessionStatuses.COMPLETED
        ),
        requestAbort: await AgentSessionRepository.requestAbort(pool, wsA, foreignRunning),
        setEpisodeSummary: await AgentSessionRepository.setEpisodeSummary(pool, wsA, foreignRunning, "leak"),
        setReflectiveCaptured: await AgentSessionRepository.setReflectiveCaptured(
          pool,
          wsA,
          foreignRunning,
          new Date()
        ),
        completeSession: await AgentSessionRepository.completeSession(pool, wsA, foreignRunning, {
          lastSeenSequence: 9n,
        }),
      }
      await AgentSessionRepository.updateHeartbeat(pool, wsA, foreignRunning)
      await AgentSessionRepository.updateCurrentStepType(pool, wsA, foreignRunning, AgentStepTypes.THINKING)
      await AgentSessionRepository.updateContextMessageIds(pool, wsA, foreignRunning, ["msg_leak"])
      await AgentSessionRepository.markResponseValidationFailed(pool, wsA, foreignRunning)
      await AgentSessionRepository.updateLastSeenSequence(pool, wsA, foreignRunning, 5n)
      await AgentSessionRepository.clearReflectiveCaptured(pool, wsA, foreignCaptured)

      expect({ results, rows: await rawRows("agent_sessions", tracked) }).toEqual({
        results: {
          updateStatus: null,
          requestAbort: false,
          setEpisodeSummary: false,
          setReflectiveCaptured: false,
          completeSession: null,
        },
        rows: before,
      })
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

    test("should update the reply key generation only when the session and its invocation share the workspace", async () => {
      const { wsA } = scope
      const generation = async (session: string) => (await rawRows("agent_sessions", [session]))[0].reply_key_generation
      const results = {
        own: await AgentSessionRepository.updateInvocationReplyKeyGeneration(pool, {
          workspaceId: wsA,
          invocationId: ownInvocation,
          replyKeyGeneration: 4,
        }),
        foreignSession: await AgentSessionRepository.updateInvocationReplyKeyGeneration(pool, {
          workspaceId: wsA,
          invocationId: foreignInvocation,
          replyKeyGeneration: 4,
        }),
        foreignInvocation: await AgentSessionRepository.updateInvocationReplyKeyGeneration(pool, {
          workspaceId: wsA,
          invocationId: crossInvocation,
          replyKeyGeneration: 4,
        }),
        foreignSessionOwnInvocation: await AgentSessionRepository.updateInvocationReplyKeyGeneration(pool, {
          workspaceId: wsA,
          invocationId: crossSession,
          replyKeyGeneration: 4,
        }),
      }

      expect({
        results,
        generations: [
          await generation(ownInvocation),
          await generation(foreignInvocation),
          await generation(crossInvocation),
          await generation(crossSession),
        ],
      }).toEqual({
        results: { own: true, foreignSession: false, foreignInvocation: false, foreignSessionOwnInvocation: false },
        generations: [4, null, null, null],
      })
    })

    test("should apply session writes within its own workspace", async () => {
      const { wsA } = scope
      const abort = await AgentSessionRepository.requestAbort(pool, wsA, ownRunning)
      await AgentSessionRepository.updateCurrentStepType(pool, wsA, ownRunning, AgentStepTypes.THINKING)
      await AgentSessionRepository.updateContextMessageIds(pool, wsA, ownRunning, ["msg_one", "msg_two"])
      const firstSummary = await AgentSessionRepository.setEpisodeSummary(pool, wsA, ownRunning, "own summary")
      const secondSummary = await AgentSessionRepository.setEpisodeSummary(pool, wsA, ownRunning, "overwrite")
      const captured = await AgentSessionRepository.setReflectiveCaptured(pool, wsA, ownRunning, at(1))
      await AgentSessionRepository.markResponseValidationFailed(pool, wsA, ownRunning)
      await AgentSessionRepository.updateLastSeenSequence(pool, wsA, ownRunning, 7n)
      const afterWrites = await AgentSessionRepository.findById(pool, wsA, ownRunning)
      await AgentSessionRepository.clearReflectiveCaptured(pool, wsA, ownRunning)
      await AgentSessionRepository.updateHeartbeat(pool, wsA, ownRunning)
      const completed = await AgentSessionRepository.completeSession(pool, wsA, ownRunning, { lastSeenSequence: 8n })
      const final = await AgentSessionRepository.findById(pool, wsA, ownRunning)

      expect({
        flags: { abort, firstSummary, secondSummary, captured },
        afterWrites: {
          currentStepType: afterWrites?.currentStepType,
          contextMessageIds: afterWrites?.contextMessageIds,
          episodeSummary: afterWrites?.episodeSummary,
          responseValidationFailed: afterWrites?.responseValidationFailed,
          lastSeenSequence: afterWrites?.lastSeenSequence,
          abortRequestedAt: afterWrites?.abortRequestedAt,
          reflectiveCapturedAt: afterWrites?.reflectiveCapturedAt,
        },
        final: {
          status: final?.status,
          completedStatus: completed?.status,
          reflectiveCapturedAt: final?.reflectiveCapturedAt,
          heartbeatRefreshed: final?.heartbeatAt !== null && final!.heartbeatAt!.getTime() > at(60).getTime(),
        },
      }).toEqual({
        flags: { abort: true, firstSummary: true, secondSummary: false, captured: true },
        afterWrites: {
          currentStepType: AgentStepTypes.THINKING,
          contextMessageIds: ["msg_one", "msg_two"],
          episodeSummary: "own summary",
          responseValidationFailed: true,
          lastSeenSequence: 7n,
          abortRequestedAt: expect.any(Date),
          reflectiveCapturedAt: expect.any(Date),
        },
        final: {
          status: AgentSessionStatuses.COMPLETED,
          completedStatus: AgentSessionStatuses.COMPLETED,
          reflectiveCapturedAt: null,
          heartbeatRefreshed: true,
        },
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

  describe("personas, attachments, summaries and participants", () => {
    let scope: Scope
    let streamOwn: string
    let streamForeign: string
    let boundOne: string
    let boundTwo: string
    let boundForeignInA: string
    let personaCapped: string
    let foreignCappedBinding: string

    beforeAll(async () => {
      scope = await seedScope("small-repos")
      const { wsA, wsB, userA, userB, personaA, personaB } = scope
      streamOwn = await addStream(wsA, userA)
      streamForeign = await addStream(wsB, userB)

      boundOne = await addAttachment(wsA)
      boundTwo = await addAttachment(wsA)
      await addBinding(wsA, personaA, boundOne, 0)
      await addBinding(wsA, personaA, boundTwo, 1)
      await addExtraction(wsA, boundOne, "own summary", "own full text")
      // B's extraction row under A's attachment id: an unpinned join reports the file as extracted.
      await addExtraction(wsB, boundTwo, "foreign summary", "foreign full text")

      // A binding whose attachment row belongs to B, and a B binding under A's persona.
      boundForeignInA = await addAttachment(wsB)
      await addBinding(wsA, personaA, boundForeignInA, 2)
      await addBinding(wsB, personaA, await addAttachment(wsB), 0)

      personaCapped = personaId()
      await addPersona(wsA, personaCapped)
      await addBinding(wsA, personaCapped, await addAttachment(wsA), 0)
      foreignCappedBinding = await addAttachment(wsB)
      await addBinding(wsB, personaCapped, foreignCappedBinding, 7)

      await insertRow("agent_conversation_summaries", {
        id: agentConversationSummaryId(),
        workspace_id: wsB,
        stream_id: streamForeign,
        persona_id: personaB,
        summary: "B secret summary",
        last_summarized_sequence: 9,
      })
      await insertRow("stream_persona_participants", {
        workspace_id: wsB,
        stream_id: streamForeign,
        persona_id: personaB,
      })
    })

    test("should find personas only inside its own workspace", async () => {
      const { wsA, personaA, personaB } = scope
      expect({
        own: (await PersonaRepository.findById(pool, wsA, personaA))?.id,
        foreign: await PersonaRepository.findById(pool, wsA, personaB),
        many: (await PersonaRepository.findByIds(pool, wsA, [personaA, personaB])).map((persona) => persona.id),
      }).toEqual({ own: personaA, foreign: null, many: [personaA] })
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

    test("should list only its own workspace's bound attachments and their extractions", async () => {
      const { wsA, personaA } = scope
      const listed = await PersonaAttachmentRepository.listForPersona(pool, wsA, personaA)
      const withContent = await PersonaAttachmentRepository.listForPersonaWithContent(pool, wsA, personaA)

      expect({
        listed: listed.map((item) => [item.attachmentId, item.position, item.hasExtraction, item.summaryChars]),
        withContent: withContent.map((item) => [item.attachmentId, item.hasExtraction, item.summary, item.fullText]),
      }).toEqual({
        listed: [
          [boundOne, 0, true, "own summary".length],
          [boundTwo, 1, false, null],
        ],
        withContent: [
          [boundOne, true, "own summary", "own full text"],
          [boundTwo, false, null, null],
        ],
      })
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

    test("should read conversation summaries only inside its own workspace", async () => {
      const { wsA, personaA, personaB } = scope
      await ConversationSummaryRepository.upsert(pool, {
        id: agentConversationSummaryId(),
        workspaceId: wsA,
        streamId: streamOwn,
        personaId: personaA,
        summary: "own summary",
        lastSummarizedSequence: 3n,
      })

      const results = {
        own: (await ConversationSummaryRepository.findByStreamAndPersona(pool, wsA, streamOwn, personaA))?.summary,
        foreign: await ConversationSummaryRepository.findByStreamAndPersona(pool, wsA, streamForeign, personaB),
      }

      expect(results).toEqual({ own: "own summary", foreign: null })
    })

    test("should report persona participation only inside its own workspace", async () => {
      const { wsA, personaA, personaB } = scope
      const client = await pool.connect()
      try {
        const before = await StreamPersonaParticipantRepository.hasParticipated(client, wsA, streamOwn, personaA)
        await StreamPersonaParticipantRepository.recordParticipation(client, wsA, streamOwn, personaA)
        expect({
          before,
          own: await StreamPersonaParticipantRepository.hasParticipated(client, wsA, streamOwn, personaA),
          foreign: await StreamPersonaParticipantRepository.hasParticipated(client, wsA, streamForeign, personaB),
        }).toEqual({ before: false, own: true, foreign: false })
      } finally {
        client.release()
      }
    })
  })

  describe("delegations", () => {
    let scope: Scope
    let streamOwn: string
    let streamForeign: string
    let foreignOpen: string
    let foreignExpired: string
    let foreignClaimed: string
    let taskWithEvent: string
    let taskWithForeignEvent: string
    let createdEvent: string

    beforeAll(async () => {
      scope = await seedScope("delegations")
      const { wsA, wsB, userA, userB } = scope
      streamOwn = await addStream(wsA, userA)
      streamForeign = await addStream(wsB, userB)

      taskWithEvent = await addTask(wsA, streamOwn, { createdAt: at(30) })
      taskWithForeignEvent = await addTask(wsA, streamOwn, { createdAt: at(20) })
      createdEvent = await addEvent(wsA, streamOwn, "delegation:created", { delegationId: taskWithEvent })
      // B's copy of the card event on A's stream: an unpinned join anchors A's task to it.
      await addEvent(wsB, streamOwn, "delegation:created", { delegationId: taskWithForeignEvent })
      // B's delegation listed under A's stream id.
      await addTask(wsB, streamOwn, { createdAt: at(10) })

      foreignOpen = await addTask(wsB, streamForeign)
      foreignExpired = await addTask(wsB, streamForeign, {
        status: DelegationStatuses.EXPIRED,
        claim_token_hash: "b-hash",
      })
      foreignClaimed = await addTask(wsB, streamForeign, {
        status: DelegationStatuses.CLAIMED,
        claim_token_hash: "b-hash",
        claim_idempotency_key: "b-key",
        claim_expires_at: new Date(Date.now() + 3_600_000),
      })
      // An A-workspace event row on B's stream: only the subquery pin keeps B's task from resolving through it.
      await addEvent(wsA, streamForeign, "delegation:created", { delegationId: foreignClaimed })
    })

    test("should read a delegation by id only inside its own workspace", async () => {
      const { wsA } = scope
      const found = await DelegatedTaskRepository.findById(pool, wsA, taskWithEvent)
      const withEvent = await DelegatedTaskRepository.findByIdWithEvent(pool, wsA, taskWithEvent)
      expect({
        own: found?.id,
        withEvent: withEvent && { id: withEvent.id, createdEventId: withEvent.createdEventId },
        foreign: await DelegatedTaskRepository.findById(pool, wsA, foreignOpen),
        foreignWithEvent: await DelegatedTaskRepository.findByIdWithEvent(pool, wsA, foreignOpen),
      }).toEqual({
        own: taskWithEvent,
        withEvent: { id: taskWithEvent, createdEventId: createdEvent },
        foreign: null,
        foreignWithEvent: null,
      })
    })

    test("should anchor a delegation only to its own workspace's created event", async () => {
      const { wsA } = scope
      const listed = await DelegatedTaskRepository.listByStream(pool, wsA, streamOwn)
      const withForeignEvent = await DelegatedTaskRepository.findByIdWithEvent(pool, wsA, taskWithForeignEvent)
      expect({
        listed: listed.map((task) => [task.id, task.createdEventId]),
        withForeignEvent: withForeignEvent?.createdEventId,
        createdEventIds: [
          await DelegatedTaskRepository.findCreatedEventId(pool, wsA, taskWithEvent),
          await DelegatedTaskRepository.findCreatedEventId(pool, wsA, taskWithForeignEvent),
          await DelegatedTaskRepository.findCreatedEventId(pool, wsA, foreignClaimed),
        ],
      }).toEqual({
        listed: [
          [taskWithForeignEvent, null],
          [taskWithEvent, createdEvent],
        ],
        withForeignEvent: null,
        createdEventIds: [createdEvent, null, null],
      })
    })

    test("should list only its own workspace's open delegations", async () => {
      const wsC = await seedWorkspace("delegations-open-c")
      const wsD = await seedWorkspace("delegations-open-d")
      const stream = streamId()
      const own = await addTask(wsC, stream, { createdAt: at(5) })
      await addTask(wsC, stream, { status: DelegationStatuses.COMPLETED })
      await addTask(wsD, stream, { createdAt: at(4) })

      expect(ids(await DelegatedTaskRepository.listOpen(pool, wsC))).toEqual([own])
    })

    test("should leave another workspace's delegation untouched when transitioning with a foreign id", async () => {
      const { wsA } = scope
      const tracked = [foreignOpen, foreignExpired, foreignClaimed]
      const before = await rawRows("delegated_tasks", tracked)
      const token = { claimTokenHash: "b-hash" }

      const results = {
        claim: await DelegatedTaskRepository.claim(pool, {
          workspaceId: wsA,
          id: foreignOpen,
          claimTokenHash: "a-hash",
          claimIdempotencyKey: null,
          claimedByLabel: "a",
          ttlSeconds: 60,
        }),
        reclaim: await DelegatedTaskRepository.reclaimByIdempotencyKey(pool, {
          workspaceId: wsA,
          id: foreignClaimed,
          claimIdempotencyKey: "b-key",
          claimTokenHash: "a-hash",
          ttlSeconds: 60,
        }),
        renew: await DelegatedTaskRepository.renewClaim(pool, {
          workspaceId: wsA,
          id: foreignClaimed,
          ttlSeconds: 60,
          ...token,
        }),
        running: await DelegatedTaskRepository.markRunning(pool, {
          workspaceId: wsA,
          id: foreignClaimed,
          ttlSeconds: 60,
          statusNote: "leak",
          ...token,
        }),
        locked: await DelegatedTaskRepository.findClaimedForUpdate(pool, {
          workspaceId: wsA,
          id: foreignClaimed,
          ...token,
        }),
        complete: await DelegatedTaskRepository.complete(pool, {
          workspaceId: wsA,
          id: foreignClaimed,
          resultMessageId: null,
          ...token,
        }),
        fail: await DelegatedTaskRepository.fail(pool, {
          workspaceId: wsA,
          id: foreignClaimed,
          statusNote: "leak",
          ...token,
        }),
        release: await DelegatedTaskRepository.release(pool, { workspaceId: wsA, id: foreignClaimed, ...token }),
        markDone: await DelegatedTaskRepository.markDone(pool, { workspaceId: wsA, id: foreignClaimed }),
        markCancelled: await DelegatedTaskRepository.markCancelled(pool, { workspaceId: wsA, id: foreignOpen }),
        requeue: await DelegatedTaskRepository.requeue(pool, { workspaceId: wsA, id: foreignExpired }),
      }

      expect({ results, rows: await rawRows("delegated_tasks", tracked) }).toEqual({
        results: {
          claim: null,
          reclaim: null,
          renew: null,
          running: null,
          locked: null,
          complete: null,
          fail: null,
          release: null,
          markDone: null,
          markCancelled: null,
          requeue: null,
        },
        rows: before,
      })
    })

    test("should transition its own workspace's delegations", async () => {
      const { wsA } = scope
      const statusOf = (task: { status: string } | null) => task?.status ?? null
      const open = () => addTask(wsA, streamOwn)
      const claim = (id: string, key: string | null = null) =>
        DelegatedTaskRepository.claim(pool, {
          workspaceId: wsA,
          id,
          claimTokenHash: "a-hash",
          claimIdempotencyKey: key,
          claimedByLabel: "agent",
          ttlSeconds: 60,
        })
      const token = { workspaceId: wsA, claimTokenHash: "a-hash" }

      const completed = await open()
      await claim(completed, "a-key")
      const reclaimed = await DelegatedTaskRepository.reclaimByIdempotencyKey(pool, {
        workspaceId: wsA,
        id: completed,
        claimIdempotencyKey: "a-key",
        claimTokenHash: "a-hash",
        ttlSeconds: 60,
      })
      const renewed = await DelegatedTaskRepository.renewClaim(pool, { ...token, id: completed, ttlSeconds: 60 })
      const running = await DelegatedTaskRepository.markRunning(pool, {
        ...token,
        id: completed,
        ttlSeconds: 60,
        statusNote: "halfway",
      })
      const locked = await DelegatedTaskRepository.findClaimedForUpdate(pool, { ...token, id: completed })
      const done = await DelegatedTaskRepository.complete(pool, { ...token, id: completed, resultMessageId: null })

      const failed = await open()
      await claim(failed)
      const failure = await DelegatedTaskRepository.fail(pool, { ...token, id: failed, statusNote: "broke" })

      const released = await open()
      await claim(released)
      const reopened = await DelegatedTaskRepository.release(pool, { ...token, id: released })

      const markedDone = await DelegatedTaskRepository.markDone(pool, { workspaceId: wsA, id: await open() })
      const cancelled = await DelegatedTaskRepository.markCancelled(pool, { workspaceId: wsA, id: await open() })
      const expired = await addTask(wsA, streamOwn, { status: DelegationStatuses.EXPIRED })
      const requeued = await DelegatedTaskRepository.requeue(pool, { workspaceId: wsA, id: expired })

      expect({
        reclaimed: statusOf(reclaimed),
        renewed: statusOf(renewed),
        running: statusOf(running),
        locked: statusOf(locked),
        done: statusOf(done),
        failure: statusOf(failure),
        reopened: statusOf(reopened),
        markedDone: statusOf(markedDone),
        cancelled: statusOf(cancelled),
        requeued: statusOf(requeued),
      }).toEqual({
        reclaimed: DelegationStatuses.CLAIMED,
        renewed: DelegationStatuses.CLAIMED,
        running: DelegationStatuses.RUNNING,
        locked: DelegationStatuses.RUNNING,
        done: DelegationStatuses.COMPLETED,
        failure: DelegationStatuses.FAILED,
        reopened: DelegationStatuses.OPEN,
        markedDone: DelegationStatuses.COMPLETED,
        cancelled: DelegationStatuses.CANCELLED,
        requeued: DelegationStatuses.OPEN,
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
