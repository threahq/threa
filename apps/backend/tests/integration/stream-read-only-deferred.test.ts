import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import { Pool } from "pg"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { EventService } from "../../src/features/messaging"
import { ScheduledMessagesRepository, ScheduledMessagesService } from "../../src/features/scheduled-messages"
import {
  assertStreamWritable,
  StreamBriefService,
  StreamMemberRepository,
  StreamRepository,
  StreamService,
} from "../../src/features/streams"
import {
  agentFollowUpId,
  botChannelAccessId,
  botInvocationId,
  enclaveInvocationId,
  messageId,
  sessionId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"
import {
  AgentSessionStatuses,
  AuthorTypes,
  BotInvocationCapabilities,
  BotInvocationTriggers,
  ENCLAVE_CALLBACK_TOKEN_HEADER,
  THREA_CALLBACK_TOKEN_HEADER,
} from "@threa/types"
import { CommandRegistry, createCommandWorker, insertCommandDispatchedEvent } from "../../src/features/commands"
import {
  AgentFollowUpRepository,
  AgentFollowUpService,
  AgentSessionRepository,
  ARIADNE_AGENT_ID,
  checkForUnseenMessages,
  createPersonaAgentWorker,
  hashCallbackToken,
  withCompanionSession,
} from "../../src/features/agents"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { BotInvocationRepository, BotRuntimeService, type BotInvocation } from "../../src/features/bot-runtimes"
import { createPublicApiHandlers, type PublicApiDeps } from "../../src/features/public-api/handlers"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../src/features/e2e-streams"
import { DelegationService } from "../../src/features/delegations"
import { createDelegationPublicApiHandlers } from "../../src/features/public-api"
import { createEnclaveSessionHandlers } from "../../src/features/enclave-runtimes/session-handlers"
import { EnclaveClaimService, EnclaveInvocationsRepository } from "../../src/features/enclave-runtimes"
import { JobQueues } from "../../src/lib/queue"

const rejection = (reason: string) => ({ code: "STREAM_READ_ONLY", details: { reason } })

describe("deferred generated output authority", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let workspace: string
  let member: string
  let outsider: string

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("stream_read_only_deferred")
    pool = isolated.pool
    cleanup = isolated.cleanup
    workspace = workspaceId()
    member = userId()
    outsider = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, { id: workspace, name: "Deferred", slug: workspace, createdBy: member })
      member = (await addTestMember(client, workspace, member)).id
      outsider = (await addTestMember(client, workspace, outsider)).id
    })
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seed(overrides: Partial<Parameters<typeof StreamRepository.insert>[1]> = {}) {
    const id = streamId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id,
        workspaceId: workspace,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: member,
        ...overrides,
      })
      await StreamMemberRepository.insert(client, id, member)
    })
    return id
  }

  async function generatedSend(target: string, initiatingUserId: string) {
    return new EventService(pool).createGeneratedMessage(
      { kind: "user", userId: initiatingUserId },
      {
        id: messageId(),
        workspaceId: workspace,
        streamId: target,
        authorId: "persona_generated",
        authorType: AuthorTypes.PERSONA,
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "late" }] }] },
        contentMarkdown: "late",
      }
    )
  }

  interface BotCallbackFixture {
    target: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
    sealed: boolean
  }

  async function seedBotCallback(
    params: {
      visibility?: "private" | "public"
      sealed?: boolean
    } = {}
  ): Promise<BotCallbackFixture> {
    const target = await seed({ visibility: params.visibility ?? "private" })
    const botId = `bot_deferred_${crypto.randomUUID()}`
    const invocationId = botInvocationId()
    const instanceId = `instance_${crypto.randomUUID()}`
    const claimToken = `claim_${crypto.randomUUID()}`

    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,$4)", [
        botId,
        workspace,
        `key_${crypto.randomUUID()}`,
        "Deferred bot",
      ])
      await BotChannelAccessRepository.grantAccess(client, {
        id: botChannelAccessId(),
        workspaceId: workspace,
        botId,
        streamId: target,
        grantedBy: member,
      })
      if (params.sealed) {
        await E2eStreamsRepository.markStreamE2e(client, {
          streamId: target,
          workspaceId: workspace,
          ownerUserId: member,
          ownerUserKeyId: `ukey_${crypto.randomUUID()}`,
          currentKeyGeneration: 3,
        })
      }
    })

    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: params.sealed ? "" : "invoke",
          ...(params.sealed && {
            ciphertext: Buffer.from("sealed trigger"),
            envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
            e2eVersion: 2,
          }),
        }
      )
    ).message

    await withTransaction(pool, async (client) => {
      await BotInvocationRepository.insertIdempotent(client, {
        id: invocationId,
        workspaceId: workspace,
        rootStreamId: target,
        activeStreamId: target,
        sourceMessageId: trigger.id,
        responseStreamId: target,
        actorType: AuthorTypes.BOT,
        actorId: botId,
        trigger: BotInvocationTriggers.MENTION,
        requiredCapability: BotInvocationCapabilities.MENTIONABLE,
        promptMarkdown: "invoke",
        authorUserId: member,
        mentionedActorSlugs: [],
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        metadata: {},
        sourceMessageRevision: trigger.revision,
      })
      await client.query(
        "UPDATE bot_invocations SET status='claimed', claimed_by_instance_id=$2, claim_token=$3, claim_expires_at=NOW()+INTERVAL '5 minutes', claimed_source_message_revision=source_message_revision WHERE id=$1",
        [invocationId, instanceId, claimToken]
      )
      if (params.sealed) {
        await AgentSessionRepository.insertRunningOrSkip(client, {
          id: invocationId,
          streamId: target,
          personaId: botId,
          triggerMessageId: trigger.id,
          initialSequence: trigger.sequence,
          callbackTokenHash: hashCallbackToken(claimToken),
          replyKeyGeneration: 3,
        })
      } else {
        await AgentSessionRepository.insert(client, {
          id: invocationId,
          streamId: target,
          personaId: botId,
          triggerMessageId: trigger.id,
          status: AgentSessionStatuses.RUNNING,
        })
      }
    })

    return { target, botId, invocationId, instanceId, claimToken, sealed: params.sealed ?? false }
  }

  function coordinateCallbackSnapshots(service: BotRuntimeService, participants = 2): BotRuntimeService {
    let arrivals = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return new Proxy(service, {
      get(target, property, receiver) {
        if (property === "findInvocationForCallback") {
          return async (...args: Parameters<BotRuntimeService["findInvocationForCallback"]>) => {
            const invocation = await target.findInvocationForCallback(...args)
            if (invocation?.status === "claimed" && arrivals < participants) {
              arrivals += 1
              if (arrivals === participants) release()
              await gate
            }
            return invocation
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }

  function buildBotCallbackHandlers(runtimeService = new BotRuntimeService({ pool })) {
    const io = {
      to: () => ({ emit: () => undefined }),
    } as unknown as PublicApiDeps["io"]
    return createPublicApiHandlers({
      pool,
      io,
      eventService: new EventService(pool),
      streamService: new StreamService(pool),
      botRuntimeService: runtimeService,
      botChannelService: new BotChannelService({ pool }),
      searchService: {} as PublicApiDeps["searchService"],
      memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
      attachmentService: {} as PublicApiDeps["attachmentService"],
      labelService: {} as PublicApiDeps["labelService"],
      labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    })
  }

  function responseRecorder(): { res: Response; payloads: unknown[] } {
    const payloads: unknown[] = []
    const res = {} as Response
    res.status = (() => res) as Response["status"]
    res.json = ((payload: unknown) => {
      payloads.push(payload)
      return res
    }) as Response["json"]
    return { res, payloads }
  }

  async function completePlaintextCallback(
    handlers: ReturnType<typeof createPublicApiHandlers>,
    fixture: BotCallbackFixture,
    overrides: { botId?: string; instanceId?: string; claimToken?: string } = {}
  ) {
    const { res, payloads } = responseRecorder()
    await handlers.completeBotInvocation(
      {
        workspaceId: workspace,
        params: { invocationId: fixture.invocationId },
        botApiKey: { botId: overrides.botId ?? fixture.botId },
        body: {
          instanceId: overrides.instanceId ?? fixture.instanceId,
          claimToken: overrides.claimToken ?? fixture.claimToken,
          finalMessageMarkdown: "committed bot result",
        },
      } as unknown as Request,
      res
    )
    return payloads[0] as { data: { invocationId: string; message: { id: string } | null } }
  }

  async function sendPlaintextCallback(
    handlers: ReturnType<typeof createPublicApiHandlers>,
    fixture: BotCallbackFixture,
    content = "interim bot message"
  ) {
    const { res, payloads } = responseRecorder()
    await handlers.sendBotInvocationMessage(
      {
        workspaceId: workspace,
        params: { invocationId: fixture.invocationId },
        botApiKey: { botId: fixture.botId },
        body: {
          instanceId: fixture.instanceId,
          claimToken: fixture.claimToken,
          content,
          clientMessageId: `remote-send-${fixture.invocationId}-1`,
        },
      } as unknown as Request,
      res
    )
    return payloads[0] as { data: { invocationId: string; sessionId: string; messageId: string } }
  }

  async function sendSealedCallback(
    handlers: ReturnType<typeof createPublicApiHandlers>,
    fixture: BotCallbackFixture,
    suffix = "interim"
  ) {
    const { res, payloads } = responseRecorder()
    await handlers.sendBotInvocationSealedMessage(
      {
        workspaceId: workspace,
        params: { invocationId: fixture.invocationId },
        botApiKey: { botId: fixture.botId },
        header: () => fixture.claimToken,
        body: {
          messageId: `msg_sealed_${suffix}_${fixture.invocationId}`,
          ciphertext: Buffer.from(`sealed ${suffix}`).toString("base64"),
          envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
        },
      } as unknown as Request,
      res
    )
    return payloads[0] as { data: { messageId: string } }
  }

  async function completeSealedCallback(
    handlers: ReturnType<typeof createPublicApiHandlers>,
    fixture: BotCallbackFixture,
    overrides: { botId?: string; claimToken?: string; noResponse?: boolean } = {}
  ) {
    const { res, payloads } = responseRecorder()
    const token = overrides.claimToken ?? fixture.claimToken
    await handlers.completeBotInvocationSealed(
      {
        workspaceId: workspace,
        params: { invocationId: fixture.invocationId },
        botApiKey: { botId: overrides.botId ?? fixture.botId },
        header: () => token,
        body: overrides.noResponse
          ? { noResponse: true }
          : {
              reply: {
                messageId: `msg_sealed_${fixture.invocationId}`,
                ciphertext: Buffer.from("sealed result").toString("base64"),
                envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
              },
            },
      } as unknown as Request,
      res
    )
    return payloads[0] as { data: { invocationId: string; sessionId: string; messageId: string | null } }
  }

  test("ScheduledMessagesService.fire terminalizes archived and privately removed rows exactly once", async () => {
    const eventService = new EventService(pool)
    const service = new ScheduledMessagesService({ pool, eventService })
    for (const scenario of ["archived", "inherited", "system", "public_leave", "removed"] as const) {
      const root = scenario === "inherited" ? await seed() : null
      const target =
        scenario === "inherited"
          ? await seed({ type: "thread", rootStreamId: root, parentStreamId: root })
          : await seed(
              scenario === "system"
                ? { type: "system", createdBy: `system_sched_${crypto.randomUUID()}` }
                : scenario === "public_leave"
                  ? { visibility: "public" }
                  : {}
            )
      const id = `sched_deferred_${scenario}`
      await withTransaction(pool, async (client) => {
        await ScheduledMessagesRepository.insert(client, {
          id,
          workspaceId: workspace,
          userId: member,
          streamId: target,
          parentMessageId: null,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "late",
          attachmentIds: [],
          metadata: null,
          scheduledFor: new Date(Date.now() - 60_000),
          clientMessageId: null,
        })
      })
      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
      } else if (scenario === "inherited") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [root])
      } else if (scenario === "public_leave" || scenario === "removed") {
        await pool.query("DELETE FROM stream_members WHERE stream_id=$1 AND member_id=$2", [target, member])
      }

      expect(await service.fire({ workspaceId: workspace, scheduledMessageId: id })).toEqual({
        fired: false,
        reschedule: false,
      })
      expect(await service.fire({ workspaceId: workspace, scheduledMessageId: id })).toEqual({
        fired: false,
        reschedule: false,
      })
      const row = await pool.query("SELECT status, last_error FROM scheduled_messages WHERE id=$1", [id])
      expect(row.rows[0]).toEqual({
        status: "failed",
        last_error: `STREAM_READ_ONLY:${
          scenario === "archived" || scenario === "inherited"
            ? "archived"
            : scenario === "system"
              ? "system_stream"
              : "not_a_member"
        }`,
      })
      const outputs = await pool.query(
        `SELECT
           (SELECT count(*) FROM messages WHERE stream_id=$1) messages,
           (SELECT count(*) FROM stream_events WHERE stream_id=$1 AND event_type IN ('message_created','companion_response')) events,
           (SELECT count(*) FROM outbox WHERE event_type='scheduled_message:upserted' AND payload->'scheduled'->>'id'=$2) personal_upserts,
           (SELECT count(*) FROM outbox WHERE payload->>'streamId'=$1 AND event_type <> 'scheduled_message:upserted') shared_outbox`,
        [target, id]
      )
      expect(outputs.rows[0]).toEqual({ messages: "0", events: "0", personal_upserts: "1", shared_outbox: "0" })
    }
  })

  test("ScheduledMessagesService.cancel remains available after archive", async () => {
    const target = await seed()
    const id = "sched_deferred_cancel"
    await withTransaction(pool, async (client) => {
      await ScheduledMessagesRepository.insert(client, {
        id,
        workspaceId: workspace,
        userId: member,
        streamId: target,
        parentMessageId: null,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "cancel",
        attachmentIds: [],
        metadata: null,
        scheduledFor: new Date(Date.now() + 60_000),
        clientMessageId: null,
      })
    })
    await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
    await new ScheduledMessagesService({ pool, eventService: new EventService(pool) }).cancel({
      workspaceId: workspace,
      userId: member,
      id,
    })
    const row = await pool.query("SELECT status FROM scheduled_messages WHERE id=$1", [id])
    expect(row.rows[0].status).toBe("cancelled")
  })

  test("follow-up list and cancel remain available after archive", async () => {
    const target = await seed()
    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "schedule a follow-up",
        }
      )
    ).message
    const sourceSessionId = sessionId()
    await AgentSessionRepository.insert(pool, {
      id: sourceSessionId,
      streamId: target,
      personaId: "persona_followup_control",
      triggerMessageId: trigger.id,
      status: AgentSessionStatuses.COMPLETED,
    })
    const service = new AgentFollowUpService({
      pool,
      workspaceSettingsService: { getSettings: async () => ({ maxPendingFollowUps: 5 }) },
    })
    const scheduled = await service.schedule({
      workspaceId: workspace,
      streamId: target,
      requestedStreamId: target,
      initiatingUserId: member,
      personaId: "persona_followup_control",
      sessionId: sourceSessionId,
      sourceConversationId: null,
      note: "check later",
      scheduledFor: new Date(Date.now() + 60_000),
    })
    if (!scheduled.ok) throw new Error("Expected follow-up")
    await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])

    expect(await service.listPending({ workspaceId: workspace, streamId: target })).toHaveLength(1)
    const cancelled = await service.cancel({
      workspaceId: workspace,
      id: scheduled.followUp.id,
      streamId: target,
      cancelledBy: { actorId: member, actorType: AuthorTypes.USER },
    })
    expect(cancelled?.status).toBe("cancelled")
    expect(await service.listPending({ workspaceId: workspace, streamId: target })).toEqual([])
  })

  test("scheduled/persona generated output is denied after target archive without message or shared outbox", async () => {
    const target = await seed()
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [target])
    await expect(generatedSend(target, member)).rejects.toMatchObject(rejection("archived"))
    const result = await pool.query(
      "SELECT (SELECT count(*) FROM messages WHERE stream_id=$1) messages, (SELECT count(*) FROM outbox WHERE payload->>'streamId'=$1) outbox",
      [target]
    )
    expect(result.rows[0]).toEqual({ messages: "0", outbox: "0" })
  })

  test("createCommandWorker terminalizes denied work once while invite/stop/status remain executable", async () => {
    const target = await seed()
    const commandId = "cmd_deferred_work"
    await withTransaction(pool, (client) =>
      insertCommandDispatchedEvent(client, {
        workspaceId: workspace,
        streamId: target,
        userId: member,
        commandId,
        name: "work",
        args: "",
      })
    )
    let workExecutions = 0
    const lifecycleExecutions = new Map<string, number>()
    const registry = new CommandRegistry()
    registry.register({
      name: "work",
      description: "work",
      execute: async () => {
        workExecutions++
        return { success: true }
      },
    })
    for (const name of ["invite", "stop", "status"] as const) {
      registry.register({
        name,
        description: name,
        execute: async () => {
          lifecycleExecutions.set(name, (lifecycleExecutions.get(name) ?? 0) + 1)
          return { success: true }
        },
      })
    }
    await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
    const worker = createCommandWorker({ pool, commandRegistry: registry })
    const job = {
      id: "job_work",
      data: { commandId, commandName: "work", args: "", workspaceId: workspace, streamId: target, userId: member },
    } as any
    await worker(job)
    await worker(job)
    expect(workExecutions).toBe(0)
    const terminal = await pool.query(
      "SELECT payload FROM stream_events WHERE stream_id=$1 AND event_type='command_failed' AND payload->>'commandId'=$2",
      [target, commandId]
    )
    expect(terminal.rows).toEqual([{ payload: { commandId, error: "STREAM_READ_ONLY:archived" } }])

    for (const name of ["invite", "stop", "status"] as const) {
      await worker({
        id: `job_${name}`,
        data: {
          commandId: `cmd_deferred_${name}`,
          commandName: name,
          args: "",
          workspaceId: workspace,
          streamId: target,
          userId: member,
        },
      } as any)
      expect(lifecycleExecutions.get(name)).toBe(1)
    }
  })

  test("persona worker rejects missing initiating identity before session execution", async () => {
    let agentRuns = 0
    const worker = createPersonaAgentWorker({
      pool,
      serverId: "deferred-test",
      jobQueue: { send: async () => "queue_unused" } as any,
      agent: {
        run: async () => {
          agentRuns += 1
          return {
            status: "completed" as const,
            sessionId: sessionId(),
            streamId: "unused",
            personaId: "persona_deferred",
            messagesSent: 0,
            sentMessageIds: [],
            lastSeenSequence: 0n,
          }
        },
      },
    })
    const target = await seed({ visibility: "public" })

    for (const [index, triggeredBy] of [undefined, "system"].entries()) {
      await worker({
        id: `persona_missing_identity_${index}`,
        name: "persona.agent",
        attempt: 0,
        maxAttempts: 3,
        data: {
          workspaceId: workspace,
          streamId: target,
          messageId: `trigger_${index}`,
          personaId: "persona_deferred",
          triggeredBy,
        },
      } as any)
    }
    expect(agentRuns).toBe(0)
  })

  test("persona output denied after provider work terminalizes the real session without retry", async () => {
    const target = await seed()
    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "start a turn",
        }
      )
    ).message
    let providerStarted!: () => void
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve
    })
    let releaseProvider!: () => void
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    let providerCalls = 0

    const turn = withCompanionSession(
      {
        pool,
        triggerMessageId: trigger.id,
        streamId: target,
        personaId: "persona_generated",
        personaName: "Generated persona",
        workspaceId: workspace,
        serverId: "deferred-test",
        initialSequence: trigger.sequence,
        attempt: 0,
        maxAttempts: 3,
      },
      async () => {
        providerCalls += 1
        providerStarted()
        await release
        const message = await generatedSend(target, member)
        return { messagesSent: 1, sentMessageIds: [message.id], lastSeenSequence: trigger.sequence }
      }
    )

    await started
    await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
    releaseProvider()

    expect(await turn).toMatchObject({ status: "failed", willRetry: false, retryable: false })
    expect(providerCalls).toBe(1)
    const rows = await pool.query(
      `SELECT
         (SELECT status FROM agent_sessions WHERE trigger_message_id=$1) session_status,
         (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id='persona_generated') persona_messages,
         (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:failed') failed_events,
         (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:interrupted') interrupted_events,
         (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:completed') completed_events`,
      [trigger.id, target]
    )
    expect(rows.rows[0]).toEqual({
      session_status: "failed",
      persona_messages: "0",
      failed_events: "1",
      interrupted_events: "0",
      completed_events: "0",
    })
  })

  test("persona catch-up queue carries the actual unseen user author", async () => {
    const target = await seed()
    await new EventService(pool).createMessageForPrincipalReturningConversation(
      { kind: "user", userId: member },
      {
        workspaceId: workspace,
        streamId: target,
        authorId: member,
        authorType: AuthorTypes.USER,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "unseen",
      }
    )
    const sent: Array<{ queue: string; payload: Record<string, unknown> }> = []
    await checkForUnseenMessages({
      pool,
      jobQueue: {
        send: async (queue: string, payload: Record<string, unknown>) => {
          sent.push({ queue, payload })
          return "queue_catchup"
        },
      } as any,
      workspaceId: workspace,
      streamId: target,
      personaId: "persona_deferred",
      lastSeenSequence: 0n,
      previousJobId: "job_previous",
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].payload.triggeredBy).toBe(member)
  })

  test("inherited root archive denies follow-up/persona output", async () => {
    const root = await seed()
    const thread = await seed({ type: "thread", rootStreamId: root, parentStreamId: root })
    await pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [root])
    await expect(generatedSend(thread, member)).rejects.toMatchObject(rejection("archived"))
  })

  test("public nonparticipant and system targets produce exact terminal reasons", async () => {
    const publicTarget = await seed({ visibility: "public" })
    const systemTarget = await seed({ type: "system" })
    await expect(generatedSend(publicTarget, outsider)).rejects.toMatchObject(rejection("not_a_member"))
    await expect(generatedSend(systemTarget, member)).rejects.toMatchObject(rejection("system_stream"))
  })

  test("generated tool sinks reject archived, system, and public-nonmember authority without side effects", async () => {
    for (const scenario of ["archived", "system", "public_nonmember"] as const) {
      const target = await seed({ visibility: scenario === "public_nonmember" ? "public" : "private" })
      const presentationId = `persona_matrix_${scenario}`
      const anchor = await new EventService(pool).createGeneratedMessage(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: presentationId,
          authorType: AuthorTypes.PERSONA,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "generated anchor",
        }
      )
      const eventService = new EventService(pool)
      await eventService.addReactionForPrincipal(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          messageId: anchor.id,
          emoji: "seed",
          userId: presentationId,
          actorType: AuthorTypes.PERSONA,
        }
      )
      const sourceSessionId = sessionId()
      await AgentSessionRepository.insert(pool, {
        id: sourceSessionId,
        streamId: target,
        personaId: presentationId,
        triggerMessageId: anchor.id,
        status: AgentSessionStatuses.COMPLETED,
      })
      const followUps = new AgentFollowUpService({
        pool,
        workspaceSettingsService: { getSettings: async () => ({ maxPendingFollowUps: 10 }) },
      })
      const existingFollowUp = await followUps.schedule({
        workspaceId: workspace,
        streamId: target,
        requestedStreamId: target,
        initiatingUserId: member,
        personaId: presentationId,
        sessionId: sourceSessionId,
        sourceConversationId: null,
        note: "original",
        scheduledFor: new Date(Date.now() + 3_600_000),
      })
      if (!existingFollowUp.ok) throw new Error("Expected matrix follow-up seed")

      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
      } else if (scenario === "system") {
        await pool.query("UPDATE streams SET type='system', created_by=$2 WHERE id=$1", [target, presentationId])
      }
      const initiatingUserId = scenario === "public_nonmember" ? outsider : member
      const expected = rejection(
        scenario === "public_nonmember" ? "not_a_member" : scenario === "system" ? "system_stream" : "archived"
      )
      const before = await pool.query(
        `SELECT
           (SELECT count(*) FROM reactions WHERE message_id=$1) reactions,
           (SELECT count(*) FROM agent_follow_ups WHERE workspace_id=$2 AND stream_id=$3) follow_ups,
           (SELECT count(*) FROM stream_briefs WHERE workspace_id=$2 AND stream_id=$3) briefs,
           (SELECT count(*) FROM delegated_tasks WHERE workspace_id=$2 AND stream_id=$3) delegations,
           (SELECT count(*) FROM streams WHERE workspace_id=$2 AND parent_stream_id=$3) threads,
           (SELECT count(*) FROM stream_events WHERE stream_id=$3) events,
           (SELECT count(*) FROM outbox WHERE payload->>'streamId'=$3) outbox`,
        [anchor.id, workspace, target]
      )

      await expect(
        eventService.editGeneratedMessage(
          { kind: "user", userId: initiatingUserId },
          {
            workspaceId: workspace,
            streamId: target,
            messageId: anchor.id,
            actorId: presentationId,
            actorType: AuthorTypes.PERSONA,
            contentJson: { type: "doc", content: [] },
            contentMarkdown: "should not land",
          }
        )
      ).rejects.toMatchObject(expected)
      await expect(
        eventService.deleteGeneratedMessage(
          { kind: "user", userId: initiatingUserId },
          {
            workspaceId: workspace,
            streamId: target,
            messageId: anchor.id,
            actorId: presentationId,
            actorType: AuthorTypes.PERSONA,
          }
        )
      ).rejects.toMatchObject(expected)
      await expect(
        eventService.addReactionForPrincipal(
          { kind: "user", userId: initiatingUserId },
          {
            workspaceId: workspace,
            streamId: target,
            messageId: anchor.id,
            emoji: "eyes",
            userId: presentationId,
            actorType: AuthorTypes.PERSONA,
          }
        )
      ).rejects.toMatchObject(expected)
      await expect(
        eventService.removeReactionForPrincipal(
          { kind: "user", userId: initiatingUserId },
          {
            workspaceId: workspace,
            streamId: target,
            messageId: anchor.id,
            emoji: "seed",
            userId: presentationId,
            actorType: AuthorTypes.PERSONA,
          }
        )
      ).rejects.toMatchObject(expected)
      await expect(
        followUps.schedule({
          workspaceId: workspace,
          streamId: target,
          requestedStreamId: target,
          initiatingUserId,
          personaId: presentationId,
          sessionId: sourceSessionId,
          sourceConversationId: null,
          note: "denied",
          scheduledFor: new Date(Date.now() + 7_200_000),
        })
      ).rejects.toMatchObject(expected)
      await expect(
        followUps.update({
          workspaceId: workspace,
          streamId: target,
          requestedStreamId: target,
          initiatingUserId,
          id: existingFollowUp.followUp.id,
          note: "should not update",
        })
      ).rejects.toMatchObject(expected)
      await expect(
        new StreamBriefService({ pool }).updateGenerated({
          workspaceId: workspace,
          streamId: target,
          requestedStreamId: target,
          principal: { kind: "user", userId: initiatingUserId },
          content: "should not land",
          expectedVersion: 0,
          updatedByKind: "persona",
          updatedById: presentationId,
        })
      ).rejects.toMatchObject(expected)
      await expect(
        new DelegationService({ pool }).createGenerated(
          { kind: "user", userId: initiatingUserId },
          {
            workspaceId: workspace,
            streamId: target,
            requestedStreamId: target,
            sessionId: sourceSessionId,
            sourceConversationId: null,
            createdByKind: AuthorTypes.PERSONA,
            createdById: presentationId,
            title: "Denied delegation",
            brief: "should not land",
            contextRefs: [],
          }
        )
      ).rejects.toMatchObject(expected)
      await expect(
        new StreamService(pool).createThread({
          workspaceId: workspace,
          parentStreamId: target,
          parentAnchorId: anchor.id,
          createdBy: presentationId,
          principal: { kind: "user", userId: initiatingUserId },
        })
      ).rejects.toMatchObject(expected)

      const after = await pool.query(
        `SELECT
           (SELECT count(*) FROM reactions WHERE message_id=$1) reactions,
           (SELECT count(*) FROM agent_follow_ups WHERE workspace_id=$2 AND stream_id=$3) follow_ups,
           (SELECT count(*) FROM stream_briefs WHERE workspace_id=$2 AND stream_id=$3) briefs,
           (SELECT count(*) FROM delegated_tasks WHERE workspace_id=$2 AND stream_id=$3) delegations,
           (SELECT count(*) FROM streams WHERE workspace_id=$2 AND parent_stream_id=$3) threads,
           (SELECT count(*) FROM stream_events WHERE stream_id=$3) events,
           (SELECT count(*) FROM outbox WHERE payload->>'streamId'=$3) outbox`,
        [anchor.id, workspace, target]
      )
      expect(after.rows[0]).toEqual(before.rows[0])
      const unchanged = await pool.query("SELECT note FROM agent_follow_ups WHERE id=$1", [
        existingFollowUp.followUp.id,
      ])
      expect(unchanged.rows[0].note).toBe("original")
    }
  })

  test("delegation completion rechecks authority after a stale access precheck", async () => {
    const target = await seed()
    const delegationService = new DelegationService({ pool })
    const delegation = await delegationService.createGenerated(
      { kind: "user", userId: member },
      {
        workspaceId: workspace,
        streamId: target,
        requestedStreamId: target,
        sessionId: null,
        sourceConversationId: null,
        createdByKind: AuthorTypes.USER,
        createdById: member,
        title: "Finish safely",
        brief: "Do the work",
        contextRefs: [],
      }
    )
    const claim = await delegationService.claim({
      workspaceId: workspace,
      id: delegation.id,
      claimedByLabel: "Local runner",
    })
    if (!claim.ok) throw new Error("Expected delegation claim")

    const liveStreamService = new StreamService(pool)
    let accessRead!: () => void
    const accessWasRead = new Promise<void>((resolve) => {
      accessRead = resolve
    })
    let releaseAccess!: () => void
    const accessRelease = new Promise<void>((resolve) => {
      releaseAccess = resolve
    })
    const pausedStreamService = new Proxy(liveStreamService, {
      get(targetService, property, receiver) {
        if (property === "tryAccess") {
          return async (...args: Parameters<StreamService["tryAccess"]>) => {
            const accessible = await targetService.tryAccess(...args)
            accessRead()
            await accessRelease
            return accessible
          }
        }
        const value = Reflect.get(targetService, property, receiver)
        return typeof value === "function" ? value.bind(targetService) : value
      },
    })
    const handlers = createDelegationPublicApiHandlers({
      pool,
      delegationService,
      eventService: new EventService(pool),
      streamService: pausedStreamService,
      botChannelService: new BotChannelService({ pool }),
      botAccessRequestService: {} as never,
    })
    const before = await pool.query(
      `SELECT
         (SELECT count(*) FROM messages WHERE stream_id=$1) messages,
         (SELECT count(*) FROM streams WHERE parent_stream_id=$1) threads,
         (SELECT count(*) FROM stream_events WHERE stream_id=$1) events,
         (SELECT count(*) FROM outbox WHERE payload->>'streamId'=$1) outbox`,
      [target]
    )
    const { res } = responseRecorder()
    const completion = handlers.completeDelegation(
      {
        workspaceId: workspace,
        userApiKey: { id: "uapi_deferred" },
        user: { id: member, name: "Deferred member" },
        params: { delegationId: delegation.id },
        header: (name: string) => (name === THREA_CALLBACK_TOKEN_HEADER ? claim.claimToken : undefined),
        body: { resultMarkdown: "This must not land" },
      } as unknown as Request,
      res
    )

    await accessWasRead
    await pool.query("DELETE FROM stream_members WHERE stream_id=$1 AND member_id=$2", [target, member])
    releaseAccess()
    await expect(completion).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" })

    const after = await pool.query(
      `SELECT
         (SELECT status FROM delegated_tasks WHERE id=$2) delegation_status,
         (SELECT count(*) FROM messages WHERE stream_id=$1) messages,
         (SELECT count(*) FROM streams WHERE parent_stream_id=$1) threads,
         (SELECT count(*) FROM stream_events WHERE stream_id=$1) events,
         (SELECT count(*) FROM outbox WHERE payload->>'streamId'=$1) outbox`,
      [target, delegation.id]
    )
    expect(after.rows[0]).toEqual({ delegation_status: "claimed", ...before.rows[0] })
  })

  test("private removal hides the generated output target", async () => {
    const target = await seed()
    await pool.query("DELETE FROM stream_members WHERE stream_id=$1 AND member_id=$2", [target, member])
    await expect(generatedSend(target, member)).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" })
  })

  test("AgentFollowUpService.fire derives and enqueues the original human identity", async () => {
    const target = await seed()
    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "follow up later",
        }
      )
    ).message
    const sourceSessionId = sessionId()
    await AgentSessionRepository.insert(pool, {
      id: sourceSessionId,
      streamId: target,
      personaId: "persona_followup_identity",
      triggerMessageId: trigger.id,
      status: AgentSessionStatuses.COMPLETED,
    })
    const followUpId = agentFollowUpId()
    await AgentFollowUpRepository.insertIfUnderCap(
      pool,
      {
        id: followUpId,
        workspaceId: workspace,
        streamId: target,
        personaId: "persona_followup_identity",
        sessionId: sourceSessionId,
        sourceConversationId: null,
        note: "later",
        scheduledFor: new Date(Date.now() - 60_000),
      },
      5
    )
    const service = new AgentFollowUpService({
      pool,
      workspaceSettingsService: { getSettings: async () => ({ maxPendingFollowUps: 5 }) },
    })
    expect(await service.fire({ workspaceId: workspace, followUpId })).toEqual({ fired: true })
    const queued = await pool.query(
      "SELECT payload FROM queue_messages WHERE queue_name=$1 AND payload->>'followUpId'=$2",
      [JobQueues.PERSONA_AGENT, followUpId]
    )
    expect(queued.rows).toHaveLength(1)
    expect(queued.rows[0].payload.triggeredBy).toBe(member)
  })

  test("AgentFollowUpService.fire terminalizes archived and missing-source work without persona enqueue", async () => {
    const service = new AgentFollowUpService({
      pool,
      workspaceSettingsService: { getSettings: async () => ({ maxPendingFollowUps: 5 }) },
    })
    for (const scenario of ["archived", "missing_source"] as const) {
      const target = await seed()
      const trigger = (
        await new EventService(pool).createMessageForPrincipalReturningConversation(
          { kind: "user", userId: member },
          {
            workspaceId: workspace,
            streamId: target,
            authorId: member,
            authorType: AuthorTypes.USER,
            contentJson: { type: "doc" },
            contentMarkdown: "trigger",
          }
        )
      ).message
      const sourceSessionId = sessionId()
      await AgentSessionRepository.insert(pool, {
        id: sourceSessionId,
        streamId: target,
        personaId: "persona_followup",
        triggerMessageId: scenario === "missing_source" ? messageId() : trigger.id,
      })
      const followUpId = agentFollowUpId()
      await AgentFollowUpRepository.insertIfUnderCap(
        pool,
        {
          id: followUpId,
          workspaceId: workspace,
          streamId: target,
          personaId: "persona_followup",
          sessionId: sourceSessionId,
          sourceConversationId: null,
          note: "later",
          scheduledFor: new Date(Date.now() - 60_000),
        },
        5
      )
      if (scenario === "archived") await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
      expect(await service.fire({ workspaceId: workspace, followUpId })).toEqual({ fired: false })
      expect(await service.fire({ workspaceId: workspace, followUpId })).toEqual({ fired: false })
      const row = await pool.query("SELECT status FROM agent_follow_ups WHERE id=$1", [followUpId])
      expect(row.rows[0].status).toBe("cancelled")
      const queued = await pool.query(
        "SELECT count(*) FROM queue_messages WHERE queue_name=$1 AND payload->>'followUpId'=$2",
        [JobQueues.PERSONA_AGENT, followUpId]
      )
      expect(queued.rows[0].count).toBe("0")
    }
  })

  test("bot grant removal and archive deny final bot content", async () => {
    const target = await seed({ visibility: "public" })
    const botId = "bot_deferred"
    await expect(
      new EventService(pool).createGeneratedMessage(
        { kind: "bot", botId },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: botId,
          authorType: AuthorTypes.BOT,
          contentJson: { type: "doc" },
          contentMarkdown: "blocked",
        }
      )
    ).rejects.toMatchObject(rejection("not_a_member"))
  })

  test("bot failure control remains available after grant removal", async () => {
    const fixture = await seedBotCallback({ visibility: "public" })
    const handlers = buildBotCallbackHandlers()
    await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
    const { res, payloads } = responseRecorder()

    await handlers.failBotInvocation(
      {
        workspaceId: workspace,
        params: { invocationId: fixture.invocationId },
        botApiKey: { botId: fixture.botId },
        body: {
          instanceId: fixture.instanceId,
          claimToken: fixture.claimToken,
          errorMessage: "runner failed",
        },
      } as unknown as Request,
      res
    )

    expect(payloads[0]).toEqual({ data: { invocationId: fixture.invocationId, status: "failed" } })
    const row = await pool.query("SELECT status, error_message FROM bot_invocations WHERE id=$1", [
      fixture.invocationId,
    ])
    expect(row.rows[0]).toEqual({ status: "failed", error_message: "runner failed" })
  })

  test("bot invocation acceptance and claim recheck the bot grant with stream-first authority", async () => {
    const target = await seed({ visibility: "public" })
    const botId = `bot_deferred_${crypto.randomUUID()}`
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Deferred claim bot')", [
      botId,
      workspace,
      `key_${crypto.randomUUID()}`,
    ])
    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "invoke bot",
        }
      )
    ).message
    const service = new BotRuntimeService({ pool })
    const createParams = {
      workspaceId: workspace,
      rootStreamId: target,
      activeStreamId: target,
      sourceMessageId: trigger.id,
      responseStreamId: target,
      actorId: botId,
      trigger: BotInvocationTriggers.MENTION,
      requiredCapability: BotInvocationCapabilities.MENTIONABLE,
      promptMarkdown: "invoke bot",
      authorUserId: member,
    } as const
    await expect(service.createInvocation(createParams)).rejects.toMatchObject(rejection("not_a_member"))
    expect(
      (
        await pool.query("SELECT count(*) FROM bot_invocations WHERE actor_id=$1 AND source_message_id=$2", [
          botId,
          trigger.id,
        ])
      ).rows[0].count
    ).toBe("0")

    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: workspace,
      botId,
      streamId: target,
      grantedBy: member,
    })
    const accepted = await service.createInvocation(createParams)
    const instanceId = `instance_${crypto.randomUUID()}`
    await service.upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId,
      runtimeKind: "pi-local",
      instanceId,
      status: "available",
      acceptingInvocations: true,
    })
    await BotChannelAccessRepository.revokeAccess(pool, workspace, botId, target)
    expect(
      await service.claimNextInvocation({
        workspaceId: workspace,
        botId,
        instanceId,
        runtimeKind: "pi-local",
        claimToken: `claim_${crypto.randomUUID()}`,
        supportedCapabilities: [BotInvocationCapabilities.MENTIONABLE],
        claimTtlSeconds: 60,
      })
    ).toBeNull()
    const terminal = await pool.query("SELECT status, error_message FROM bot_invocations WHERE id=$1", [
      accepted.invocation.id,
    ])
    expect(terminal.rows[0]).toEqual({ status: "failed", error_message: "STREAM_READ_ONLY:not_a_member" })
  })

  test("active FAILED bot sessions accept an invocation message and recover on final completion", async () => {
    const fixture = await seedBotCallback({ visibility: "public" })
    const handlers = buildBotCallbackHandlers()
    await pool.query("UPDATE agent_sessions SET status='failed', error='orphan false-positive' WHERE id=$1", [
      fixture.invocationId,
    ])

    const interim = await sendPlaintextCallback(handlers, fixture, "Still working after the stale cleanup.")
    expect(interim.data).toMatchObject({
      invocationId: fixture.invocationId,
      sessionId: fixture.invocationId,
    })
    await completePlaintextCallback(handlers, fixture)

    const rows = await pool.query(
      `SELECT
         (SELECT status FROM bot_invocations WHERE id=$1) invocation_status,
         (SELECT status FROM agent_sessions WHERE id=$1) session_status,
         (SELECT error FROM agent_sessions WHERE id=$1) session_error,
         (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id=$3) bot_messages,
         (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:completed' AND payload->>'sessionId'=$1) completed_events`,
      [fixture.invocationId, fixture.target, fixture.botId]
    )
    expect(rows.rows[0]).toEqual({
      invocation_status: "completed",
      session_status: "completed",
      session_error: null,
      bot_messages: "2",
      completed_events: "1",
    })
  })

  test("active FAILED sealed sessions accept messages, recover on completion, and deny writes after the claim closes", async () => {
    const fixture = await seedBotCallback({ visibility: "public", sealed: true })
    const handlers = buildBotCallbackHandlers()
    await pool.query("UPDATE agent_sessions SET status='failed', error='orphan false-positive' WHERE id=$1", [
      fixture.invocationId,
    ])

    await sendSealedCallback(handlers, fixture)
    await completeSealedCallback(handlers, fixture)

    const recovered = await pool.query(
      `SELECT
         (SELECT status FROM bot_invocations WHERE id=$1) invocation_status,
         (SELECT status FROM agent_sessions WHERE id=$1) session_status,
         (SELECT error FROM agent_sessions WHERE id=$1) session_error,
         (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id=$3) bot_messages,
         (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:completed' AND payload->>'sessionId'=$1) completed_events`,
      [fixture.invocationId, fixture.target, fixture.botId]
    )
    expect(recovered.rows[0]).toEqual({
      invocation_status: "completed",
      session_status: "completed",
      session_error: null,
      bot_messages: "2",
      completed_events: "1",
    })

    await pool.query("UPDATE agent_sessions SET status='failed', error='late stale state' WHERE id=$1", [
      fixture.invocationId,
    ])
    await expect(sendSealedCallback(handlers, fixture, "after-close")).rejects.toMatchObject({
      status: 409,
      code: "SESSION_NOT_RUNNING",
    })
    const messages = await pool.query("SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id=$2", [
      fixture.target,
      fixture.botId,
    ])
    expect(messages.rows[0]).toEqual({ count: "2" })
  })

  test("bot callback authority denial terminalizes invocation/session once without output", async () => {
    for (const scenario of ["archived", "public_revoked", "system"] as const) {
      const fixture = await seedBotCallback({ visibility: scenario === "public_revoked" ? "public" : "private" })
      const handlers = buildBotCallbackHandlers()
      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [fixture.target])
      } else if (scenario === "system") {
        await pool.query("UPDATE streams SET type='system', created_by=$2 WHERE id=$1", [fixture.target, fixture.botId])
      } else {
        await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
      }
      const reason = scenario === "archived" ? "archived" : scenario === "system" ? "system_stream" : "not_a_member"
      await expect(completePlaintextCallback(handlers, fixture)).rejects.toMatchObject(rejection(reason))
      await expect(completePlaintextCallback(handlers, fixture)).rejects.toMatchObject({ status: 404 })
      const rows = await pool.query(
        `SELECT
           (SELECT status FROM bot_invocations WHERE id=$1) invocation_status,
           (SELECT error_message FROM bot_invocations WHERE id=$1) invocation_error,
           (SELECT status FROM agent_sessions WHERE id=$1) session_status,
           (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id=$3) bot_messages,
           (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:failed' AND payload->>'sessionId'=$1) failed_events`,
        [fixture.invocationId, fixture.target, fixture.botId]
      )
      expect(rows.rows[0]).toEqual({
        invocation_status: "failed",
        invocation_error: `STREAM_READ_ONLY:${reason}`,
        session_status: "failed",
        bot_messages: "0",
        failed_events: "1",
      })
    }
  })

  test("plaintext bot completion replays its own result after archive and public grant removal", async () => {
    for (const scenario of ["archived", "public_revoked"] as const) {
      const fixture = await seedBotCallback({ visibility: scenario === "archived" ? "private" : "public" })
      const handlers = buildBotCallbackHandlers()
      const first = await completePlaintextCallback(handlers, fixture)
      expect(first.data.message?.id).toBeTruthy()

      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [fixture.target])
      } else {
        await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
      }

      const replay = await completePlaintextCallback(handlers, fixture)
      expect(replay).toEqual(first)
      const rows = await pool.query(
        `SELECT
           (SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id=$2 AND client_message_id=$3) messages,
           (SELECT count(*) FROM stream_events WHERE stream_id=$1 AND event_type='agent_session:completed' AND payload->>'sessionId'=$4) terminal_events`,
        [fixture.target, fixture.botId, `bot-invocation:${fixture.invocationId}`, fixture.invocationId]
      )
      expect(rows.rows[0]).toEqual({ messages: "1", terminal_events: "1" })
    }
  })

  test("plaintext bot completion hides private-revoked and mismatched callback credentials", async () => {
    const fixture = await seedBotCallback()
    const handlers = buildBotCallbackHandlers()
    await completePlaintextCallback(handlers, fixture)
    await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
    await expect(completePlaintextCallback(handlers, fixture)).rejects.toMatchObject({ status: 404 })

    const visible = await seedBotCallback({ visibility: "public" })
    const visibleHandlers = buildBotCallbackHandlers()
    await completePlaintextCallback(visibleHandlers, visible)
    await expect(
      completePlaintextCallback(visibleHandlers, visible, { claimToken: "wrong-token" })
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      completePlaintextCallback(visibleHandlers, visible, { instanceId: "wrong-instance" })
    ).rejects.toMatchObject({ status: 404 })

    const otherBotId = `bot_deferred_${crypto.randomUUID()}`
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Other bot')", [
      otherBotId,
      workspace,
      `key_${crypto.randomUUID()}`,
    ])
    await expect(completePlaintextCallback(visibleHandlers, visible, { botId: otherBotId })).rejects.toMatchObject({
      status: 404,
    })
  })

  test("bot replay fails closed when its committed result row is missing", async () => {
    const fixture = await seedBotCallback({ visibility: "public" })
    const handlers = buildBotCallbackHandlers()
    const completed = await completePlaintextCallback(handlers, fixture)
    await pool.query("DELETE FROM messages WHERE id=$1", [completed.data.message!.id])

    await expect(completePlaintextCallback(handlers, fixture)).rejects.toMatchObject({ status: 404 })
  })

  test("concurrent plaintext bot completion returns one committed winner to both callbacks", async () => {
    const fixture = await seedBotCallback()
    const runtime = coordinateCallbackSnapshots(new BotRuntimeService({ pool }))
    const handlers = buildBotCallbackHandlers(runtime)
    const [first, second] = await Promise.all([
      completePlaintextCallback(handlers, fixture),
      completePlaintextCallback(handlers, fixture),
    ])
    expect(second).toEqual(first)
    const rows = await pool.query(
      `SELECT
         (SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id=$2 AND client_message_id=$3) messages,
         (SELECT count(*) FROM stream_events WHERE stream_id=$1 AND event_type='agent_session:completed' AND payload->>'sessionId'=$4) terminal_events`,
      [fixture.target, fixture.botId, `bot-invocation:${fixture.invocationId}`, fixture.invocationId]
    )
    expect(rows.rows[0]).toEqual({ messages: "1", terminal_events: "1" })
  })

  test("plaintext/sealed trace and interim bot callbacks deny revoked grants without sink rows", async () => {
    for (const callback of [
      "plaintext_step",
      "plaintext_message",
      "plaintext_message_hidden",
      "sealed_step",
      "sealed_message",
    ] as const) {
      const fixture = await seedBotCallback({
        visibility: callback === "plaintext_message_hidden" ? "private" : "public",
        sealed: callback === "sealed_step" || callback === "sealed_message",
      })
      const handlers = buildBotCallbackHandlers()
      await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
      const { res } = responseRecorder()
      if (callback === "plaintext_step") {
        await expect(
          handlers.recordBotInvocationStep(
            {
              workspaceId: workspace,
              params: { invocationId: fixture.invocationId },
              botApiKey: { botId: fixture.botId },
              body: {
                instanceId: fixture.instanceId,
                claimToken: fixture.claimToken,
                stepType: "thinking",
                content: "must not land",
              },
            } as unknown as Request,
            res
          )
        ).rejects.toMatchObject(rejection("not_a_member"))
      } else if (callback === "plaintext_message" || callback === "plaintext_message_hidden") {
        await expect(sendPlaintextCallback(handlers, fixture, "must not land")).rejects.toMatchObject(
          callback === "plaintext_message_hidden" ? { code: "STREAM_NOT_FOUND" } : rejection("not_a_member")
        )
      } else if (callback === "sealed_step") {
        await expect(
          handlers.recordBotInvocationSealedStep(
            {
              workspaceId: workspace,
              params: { invocationId: fixture.invocationId },
              botApiKey: { botId: fixture.botId },
              header: () => fixture.claimToken,
              body: {
                stepId: `step_${crypto.randomUUID()}`,
                stepType: "thinking",
                ciphertext: Buffer.from("sealed step").toString("base64"),
                envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
              },
            } as unknown as Request,
            res
          )
        ).rejects.toMatchObject(rejection("not_a_member"))
      } else {
        await expect(
          handlers.sendBotInvocationSealedMessage(
            {
              workspaceId: workspace,
              params: { invocationId: fixture.invocationId },
              botApiKey: { botId: fixture.botId },
              header: () => fixture.claimToken,
              body: {
                messageId: `msg_interim_${crypto.randomUUID()}`,
                ciphertext: Buffer.from("sealed interim").toString("base64"),
                envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
              },
            } as unknown as Request,
            res
          )
        ).rejects.toMatchObject(rejection("not_a_member"))
      }

      const rows = await pool.query(
        `SELECT
           (SELECT status FROM bot_invocations WHERE id=$1) invocation_status,
           (SELECT status FROM agent_sessions WHERE id=$1) session_status,
           (SELECT count(*) FROM agent_session_steps WHERE session_id=$1) steps,
           (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id=$3) bot_messages,
           (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:failed' AND payload->>'sessionId'=$1) failed_events`,
        [fixture.invocationId, fixture.target, fixture.botId]
      )
      expect(rows.rows[0]).toEqual({
        invocation_status: "failed",
        session_status: "failed",
        steps: "0",
        bot_messages: "0",
        failed_events: "1",
      })
    }
  })

  test("sealed bot callback denial terminalizes once without ciphertext output", async () => {
    for (const scenario of ["archived", "public_revoked", "system"] as const) {
      const fixture = await seedBotCallback({
        visibility: scenario === "public_revoked" ? "public" : "private",
        sealed: true,
      })
      const handlers = buildBotCallbackHandlers()
      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [fixture.target])
      } else if (scenario === "system") {
        await pool.query("UPDATE streams SET type='system', created_by=$2 WHERE id=$1", [fixture.target, fixture.botId])
      } else {
        await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
      }
      const reason = scenario === "archived" ? "archived" : scenario === "system" ? "system_stream" : "not_a_member"
      await expect(completeSealedCallback(handlers, fixture)).rejects.toMatchObject(rejection(reason))
      const rows = await pool.query(
        `SELECT
           (SELECT status FROM bot_invocations WHERE id=$1) invocation_status,
           (SELECT status FROM agent_sessions WHERE id=$1) session_status,
           (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id=$3) bot_messages,
           (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:failed' AND payload->>'sessionId'=$1) failed_events`,
        [fixture.invocationId, fixture.target, fixture.botId]
      )
      expect(rows.rows[0]).toEqual({
        invocation_status: "failed",
        session_status: "failed",
        bot_messages: "0",
        failed_events: "1",
      })
    }
  })

  test("sealed bot completion replays one committed ciphertext result and hides private revocation", async () => {
    for (const scenario of ["archived", "public_revoked"] as const) {
      const fixture = await seedBotCallback({
        visibility: scenario === "archived" ? "private" : "public",
        sealed: true,
      })
      const handlers = buildBotCallbackHandlers()
      const first = await completeSealedCallback(handlers, fixture)
      expect(first.data.messageId).toBe(`msg_sealed_${fixture.invocationId}`)
      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [fixture.target])
      } else {
        await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
      }
      expect(await completeSealedCallback(handlers, fixture)).toEqual(first)
    }

    const hidden = await seedBotCallback({ sealed: true })
    const hiddenHandlers = buildBotCallbackHandlers()
    await completeSealedCallback(hiddenHandlers, hidden)
    await BotChannelAccessRepository.revokeAccess(pool, workspace, hidden.botId, hidden.target)
    await expect(completeSealedCallback(hiddenHandlers, hidden)).rejects.toMatchObject({ status: 404 })
  })

  test("concurrent sealed bot completion serializes and writes one message/event", async () => {
    const fixture = await seedBotCallback({ sealed: true })
    const runtime = coordinateCallbackSnapshots(new BotRuntimeService({ pool }))
    const handlers = buildBotCallbackHandlers(runtime)
    const [first, second] = await Promise.all([
      completeSealedCallback(handlers, fixture),
      completeSealedCallback(handlers, fixture),
    ])
    expect(second).toEqual(first)
    const rows = await pool.query(
      `SELECT
         (SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id=$2 AND client_message_id=$3) messages,
         (SELECT count(*) FROM stream_events WHERE stream_id=$1 AND event_type='agent_session:completed' AND payload->>'sessionId'=$4) terminal_events`,
      [fixture.target, fixture.botId, `bot-invocation:${fixture.invocationId}`, fixture.invocationId]
    )
    expect(rows.rows[0]).toEqual({ messages: "1", terminal_events: "1" })
  })

  test("sealed noResponse completion remains available after private grant removal", async () => {
    const fixture = await seedBotCallback({ sealed: true })
    const handlers = buildBotCallbackHandlers()
    await BotChannelAccessRepository.revokeAccess(pool, workspace, fixture.botId, fixture.target)
    const completed = await completeSealedCallback(handlers, fixture, { noResponse: true })
    expect(completed.data).toMatchObject({ invocationId: fixture.invocationId, messageId: null })
    await expect(completeSealedCallback(handlers, fixture, { noResponse: true })).rejects.toMatchObject({ status: 404 })
  })

  test("sealed replay rejects wrong callback token and bot", async () => {
    const fixture = await seedBotCallback({ visibility: "public", sealed: true })
    const handlers = buildBotCallbackHandlers()
    await completeSealedCallback(handlers, fixture)
    await expect(completeSealedCallback(handlers, fixture, { claimToken: "wrong-token" })).rejects.toBeTruthy()

    const otherBotId = `bot_deferred_${crypto.randomUUID()}`
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Other sealed bot')", [
      otherBotId,
      workspace,
      `key_${crypto.randomUUID()}`,
    ])
    await expect(completeSealedCallback(handlers, fixture, { botId: otherBotId })).rejects.toBeTruthy()
  })

  test("enclave claim acceptance terminalizes archived work before returning provider context", async () => {
    const target = await seed()
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: target,
      workspaceId: workspace,
      ownerUserId: member,
      ownerUserKeyId: `ukey_${crypto.randomUUID()}`,
      currentKeyGeneration: 3,
    })
    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "",
          ciphertext: Buffer.from("sealed trigger"),
          envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
          e2eVersion: 2,
        }
      )
    ).message
    const keyId = `eik_${crypto.randomUUID()}`
    await StreamE2eKeyWrapsRepository.insertMany(pool, [
      {
        workspaceId: workspace,
        streamId: target,
        keyGeneration: 3,
        recipientKeyId: keyId,
        recipientKind: "enclave",
        wrapEnc: "ZW5j",
        wrapCt: "Y3Q=",
      },
    ])
    const invocationId = enclaveInvocationId()
    await EnclaveInvocationsRepository.insertPending(pool, {
      id: invocationId,
      workspaceId: workspace,
      streamId: target,
      rootStreamId: target,
      messageId: trigger.id,
      triggeredBy: member,
    })
    await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])

    const service = new EnclaveClaimService({
      pool,
      storage: { getObject: async () => Buffer.alloc(0) } as never,
      userPreferencesService: { getPreferences: async () => ({}) } as never,
    })
    expect(await service.claimTurn(keyId)).toBeNull()

    const rows = await pool.query(
      `SELECT status, error_message,
         (SELECT count(*) FROM agent_sessions WHERE trigger_message_id=$2) sessions
       FROM enclave_invocations WHERE id=$1`,
      [invocationId, trigger.id]
    )
    expect(rows.rows[0]).toEqual({
      status: "failed",
      error_message: "STREAM_READ_ONLY:archived",
      sessions: "0",
    })
  })

  test("a stale enclave claimant cannot fail a replacement claim", async () => {
    const target = await seed()
    const trigger = await new EventService(pool).createMessageForPrincipalReturningConversation(
      { kind: "user", userId: member },
      {
        workspaceId: workspace,
        streamId: target,
        authorId: member,
        authorType: AuthorTypes.USER,
        contentJson: { type: "doc", content: [] },
        contentMarkdown: "claim trigger",
      }
    )
    const invocationId = enclaveInvocationId()
    await EnclaveInvocationsRepository.insertPending(pool, {
      id: invocationId,
      workspaceId: workspace,
      streamId: target,
      rootStreamId: target,
      messageId: trigger.message.id,
      triggeredBy: member,
    })
    await pool.query(
      `UPDATE enclave_invocations
       SET status='claimed', claimed_by_key_id='eik_old', claim_token='token_old',
           claim_expires_at=NOW()+INTERVAL '5 minutes'
       WHERE id=$1`,
      [invocationId]
    )
    // Model lease expiry + exact reclaim without sleeping through the TTL.
    await pool.query(
      `UPDATE enclave_invocations
       SET claimed_by_key_id='eik_new', claim_token='token_new',
           claim_expires_at=NOW()+INTERVAL '5 minutes'
       WHERE id=$1`,
      [invocationId]
    )

    await EnclaveInvocationsRepository.failClaimed(pool, {
      id: invocationId,
      keyId: "eik_old",
      claimToken: "token_old",
      errorMessage: "stale denial",
    })
    expect(
      (
        await pool.query(
          "SELECT status, claimed_by_key_id, claim_token, error_message FROM enclave_invocations WHERE id=$1",
          [invocationId]
        )
      ).rows[0]
    ).toEqual({
      status: "claimed",
      claimed_by_key_id: "eik_new",
      claim_token: "token_new",
      error_message: null,
    })

    await EnclaveInvocationsRepository.failClaimed(pool, {
      id: invocationId,
      keyId: "eik_new",
      claimToken: "token_new",
      errorMessage: "current denial",
    })
    expect(
      (await pool.query("SELECT status, error_message FROM enclave_invocations WHERE id=$1", [invocationId])).rows[0]
    ).toEqual({ status: "failed", error_message: "current denial" })
  })

  test("enclave sealed output denial and missing trigger identity fail the session once", async () => {
    for (const scenario of ["archived", "removed", "missing_identity"] as const) {
      const target = await seed()
      await E2eStreamsRepository.markStreamE2e(pool, {
        streamId: target,
        workspaceId: workspace,
        ownerUserId: member,
        ownerUserKeyId: `ukey_${crypto.randomUUID()}`,
        currentKeyGeneration: 3,
      })
      const trigger =
        scenario === "missing_identity"
          ? null
          : (
              await new EventService(pool).createMessageForPrincipalReturningConversation(
                { kind: "user", userId: member },
                {
                  workspaceId: workspace,
                  streamId: target,
                  authorId: member,
                  authorType: AuthorTypes.USER,
                  contentJson: { type: "doc", content: [] },
                  contentMarkdown: "",
                  ciphertext: Buffer.from("sealed trigger"),
                  envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
                  e2eVersion: 2,
                }
              )
            ).message
      const id = sessionId()
      const token = `enclave_${crypto.randomUUID()}`
      await AgentSessionRepository.insertRunningOrSkip(pool, {
        id,
        streamId: target,
        personaId: ARIADNE_AGENT_ID,
        triggerMessageId: trigger?.id ?? messageId(),
        initialSequence: trigger?.sequence ?? 0n,
        callbackTokenHash: hashCallbackToken(token),
        replyKeyGeneration: 3,
      })
      if (scenario === "archived") {
        await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])
      } else if (scenario === "removed") {
        await pool.query("DELETE FROM stream_members WHERE stream_id=$1 AND member_id=$2", [target, member])
      }

      const io = { to: () => ({ emit: () => undefined }) } as unknown as PublicApiDeps["io"]
      const handlers = createEnclaveSessionHandlers({
        pool,
        io,
        eventService: new EventService(pool),
        costService: { recordUsage: async () => undefined },
      })
      const { res } = responseRecorder()
      const req = {
        params: { id },
        header: (name: string) => (name === ENCLAVE_CALLBACK_TOKEN_HEADER ? token : undefined),
        body: {
          messageId: `msg_enclave_${crypto.randomUUID()}`,
          ciphertext: Buffer.from("sealed output").toString("base64"),
          envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
        },
      } as unknown as Request
      await expect(handlers.message(req, res)).rejects.toMatchObject(
        scenario === "removed" ? { code: "STREAM_NOT_FOUND" } : { code: "STREAM_READ_ONLY" }
      )
      await expect(handlers.message(req, res)).rejects.toMatchObject({ status: 409 })

      const rows = await pool.query(
        `SELECT
           (SELECT status FROM agent_sessions WHERE id=$1) session_status,
           (SELECT error FROM agent_sessions WHERE id=$1) session_error,
           (SELECT count(*) FROM messages WHERE stream_id=$2 AND author_id=$3) persona_messages,
           (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:failed' AND payload->>'sessionId'=$1) failed_events`,
        [id, target, ARIADNE_AGENT_ID]
      )
      expect(rows.rows[0]).toEqual({
        session_status: "failed",
        session_error: `STREAM_READ_ONLY:${
          scenario === "archived" ? "archived" : scenario === "removed" ? "not_a_member" : "missing_initiating_user"
        }`,
        persona_messages: "0",
        failed_events: "1",
      })
    }
  })

  test("enclave naming callback cannot mutate a title after archive", async () => {
    const target = await seed()
    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: target,
      workspaceId: workspace,
      ownerUserId: member,
      ownerUserKeyId: `ukey_${crypto.randomUUID()}`,
      currentKeyGeneration: 3,
    })
    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "",
          ciphertext: Buffer.from("sealed trigger"),
          envelope: { v: 2, keyGeneration: 3, iv: "aXY=", aad: "YWFk" },
          e2eVersion: 2,
        }
      )
    ).message
    const id = sessionId()
    const token = `enclave_${crypto.randomUUID()}`
    await AgentSessionRepository.insertRunningOrSkip(pool, {
      id,
      streamId: target,
      personaId: ARIADNE_AGENT_ID,
      triggerMessageId: trigger.id,
      initialSequence: trigger.sequence,
      callbackTokenHash: hashCallbackToken(token),
      replyKeyGeneration: 3,
    })
    await pool.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target])

    const handlers = createEnclaveSessionHandlers({
      pool,
      io: { to: () => ({ emit: () => undefined }) } as unknown as PublicApiDeps["io"],
      eventService: new EventService(pool),
      costService: { recordUsage: async () => undefined },
    })
    const { res } = responseRecorder()
    const request = {
      params: { id },
      header: (name: string) => (name === ENCLAVE_CALLBACK_TOKEN_HEADER ? token : undefined),
      body: {
        action: "rename",
        confidence: 0.9,
        observedStateRevision: 0,
        observedTitleRevision: 0,
        observedMessageCount: 1,
        observedCheckpoint: 1,
        sealedReplacement: {
          ciphertext: Buffer.from("sealed name").toString("base64"),
          envelope: {
            v: 2,
            keyGeneration: 3,
            iv: "aXY=",
            aad: Buffer.from(`${target}|name|3`).toString("base64"),
          },
        },
      },
    } as unknown as Request

    await expect(handlers.namingDecision(request, res)).rejects.toMatchObject(rejection("archived"))
    await expect(handlers.namingDecision(request, res)).rejects.toMatchObject({ status: 409 })

    const rows = await pool.query(
      `SELECT
         (SELECT status FROM agent_sessions WHERE id=$1) session_status,
         (SELECT display_name_revision FROM streams WHERE id=$2) title_revision,
         (SELECT count(*) FROM stream_events WHERE stream_id=$2 AND event_type='agent_session:failed' AND payload->>'sessionId'=$1) failed_events`,
      [id, target]
    )
    expect(rows.rows[0]).toEqual({ session_status: "failed", title_revision: 0, failed_events: "1" })
    expect(await E2eStreamsRepository.getSealedName(pool, workspace, target)).toBeNull()
  })

  test("missing initiating identity fails closed before enclave-style generated output", async () => {
    const target = await seed()
    await expect(generatedSend(target, "usr_missing")).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" })
  })

  test("bot grant revocation cannot commit between final authority and generated output", async () => {
    const target = await seed({ visibility: "public" })
    const botId = `bot_contention_${crypto.randomUUID()}`
    await pool.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,'Contention bot')", [
      botId,
      workspace,
      `key_${crypto.randomUUID()}`,
    ])
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: workspace,
      botId,
      streamId: target,
      grantedBy: member,
    })
    const writer = await pool.connect()
    const revoker = await pool.connect()
    try {
      await writer.query("BEGIN")
      await assertStreamWritable(writer, {
        workspaceId: workspace,
        streamId: target,
        principal: { kind: "bot", botId },
      })
      let revokeCommitted = false
      await revoker.query("BEGIN")
      const revoke = revoker
        .query("DELETE FROM bot_channel_access WHERE workspace_id=$1 AND bot_id=$2 AND stream_id=$3", [
          workspace,
          botId,
          target,
        ])
        .then(() => {
          revokeCommitted = true
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(revokeCommitted).toBe(false)
      await new EventService(pool).createMessageForPrincipalInTransaction(
        writer,
        { kind: "bot", botId },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: botId,
          authorType: AuthorTypes.BOT,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "linearized before revoke",
        }
      )
      await writer.query("COMMIT")
      await revoke
      await revoker.query("COMMIT")
      expect(
        (await pool.query("SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id=$2", [target, botId])).rows[0]
          .count
      ).toBe("1")
      await expect(
        new EventService(pool).createGeneratedMessage(
          { kind: "bot", botId },
          {
            workspaceId: workspace,
            streamId: target,
            authorId: botId,
            authorType: AuthorTypes.BOT,
            contentJson: { type: "doc", content: [] },
            contentMarkdown: "denied after revoke",
          }
        )
      ).rejects.toMatchObject(rejection("not_a_member"))
    } finally {
      await writer.query("ROLLBACK").catch(() => {})
      await revoker.query("ROLLBACK").catch(() => {})
      writer.release()
      revoker.release()
    }
  })

  test("member removal cannot commit between final authority and generated output", async () => {
    const target = await seed()
    const writer = await pool.connect()
    const remover = await pool.connect()
    try {
      await writer.query("BEGIN")
      await assertStreamWritable(writer, {
        workspaceId: workspace,
        streamId: target,
        principal: { kind: "user", userId: member },
      })
      let removalCompleted = false
      await remover.query("BEGIN")
      const removal = remover
        .query("DELETE FROM stream_members WHERE stream_id=$1 AND member_id=$2", [target, member])
        .then(() => {
          removalCompleted = true
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(removalCompleted).toBe(false)
      await new EventService(pool).createMessageForPrincipalInTransaction(
        writer,
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: "persona_member_contention",
          authorType: AuthorTypes.PERSONA,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "linearized before removal",
        }
      )
      await writer.query("COMMIT")
      await removal
      await remover.query("COMMIT")
      expect(
        (
          await pool.query(
            "SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id='persona_member_contention'",
            [target]
          )
        ).rows[0].count
      ).toBe("1")
      await expect(generatedSend(target, member)).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" })
    } finally {
      await writer.query("ROLLBACK").catch(() => {})
      await remover.query("ROLLBACK").catch(() => {})
      writer.release()
      remover.release()
    }
  })

  test("archive cannot commit between final authority and generated output", async () => {
    const target = await seed()
    const writer = await pool.connect()
    const archiver = await pool.connect()
    try {
      await writer.query("BEGIN")
      await assertStreamWritable(writer, {
        workspaceId: workspace,
        streamId: target,
        principal: { kind: "user", userId: member },
      })
      let archiveCommitted = false
      await archiver.query("BEGIN")
      const archive = archiver.query("UPDATE streams SET archived_at=NOW() WHERE id=$1", [target]).then(() => {
        archiveCommitted = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(archiveCommitted).toBe(false)
      await new EventService(pool).createMessageForPrincipalInTransaction(
        writer,
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: "persona_contended",
          authorType: AuthorTypes.PERSONA,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "linearized before archive",
        }
      )
      expect(archiveCommitted).toBe(false)
      await writer.query("COMMIT")
      await archive
      await archiver.query("COMMIT")
      expect(
        (
          await pool.query("SELECT count(*) FROM messages WHERE stream_id=$1 AND author_id='persona_contended'", [
            target,
          ])
        ).rows[0].count
      ).toBe("1")
      await expect(generatedSend(target, member)).rejects.toMatchObject(rejection("archived"))
    } finally {
      await writer.query("ROLLBACK").catch(() => {})
      await archiver.query("ROLLBACK").catch(() => {})
      writer.release()
      archiver.release()
    }
  })
})
