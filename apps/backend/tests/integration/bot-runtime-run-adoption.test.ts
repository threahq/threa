import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Server } from "socket.io"
import type { Request, Response } from "express"
import { createPublicApiHandlers } from "../../src/features/public-api/handlers"
import { EventService } from "../../src/features/messaging"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { botRuntimeServiceFor, seedBotRuntimeFixture, withTransaction, type BotRuntimeFixture } from "./setup"
import { AgentSessionRepository } from "../../src/features/agents"
import { BotInvocationRepository, BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { BotChannelService } from "../../src/features/api-keys"
import { createBotRuntimeWriteOps } from "../../src/features/public-api/runtime-write-ops"
import { botRuntimeSessionLinkId, streamId } from "../../src/lib/id"

describe("runtime run adoption", () => {
  let fixture: BotRuntimeFixture
  const io = new Server()
  const service = () => botRuntimeServiceFor(fixture.pool)
  const params = (request = "attachment-one") => ({
    workspaceId: fixture.workspace,
    botId: fixture.bot,
    instanceId: "runtime-one",
    runtimeSessionId: "session-one",
    responseStreamId: fixture.stream,
    externalRunId: "external-run",
    attachmentRequestId: request,
    claimToken: crypto.randomUUID(),
    claimTtlSeconds: 60,
  })
  const writes = () =>
    createBotRuntimeWriteOps({
      pool: fixture.pool,
      io,
      botRuntimeService: service(),
      botChannelService: new BotChannelService({ pool: fixture.pool }),
    })

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "runtime_adoption", instanceIds: ["runtime-one"] })
  })
  afterAll(async () => {
    await fixture?.cleanup()
  })
  beforeEach(async () => {
    await fixture.pool.query(
      "DELETE FROM agent_session_steps WHERE session_id IN (SELECT id FROM agent_sessions WHERE workspace_id = $1)",
      [fixture.workspace]
    )
    for (const table of [
      "agent_sessions",
      "bot_invocations",
      "bot_runtime_session_links",
      "stream_events",
      "e2e_streams",
    ]) {
      await fixture.pool.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [fixture.workspace])
    }
    await fixture.pool.query("UPDATE streams SET archived_at = NULL WHERE workspace_id = $1", [fixture.workspace])
    await BotRuntimeSessionLinkRepository.upsert(fixture.pool, {
      id: botRuntimeSessionLinkId(),
      workspaceId: fixture.workspace,
      botId: fixture.bot,
      runtimeKind: "t3code",
      instanceId: "runtime-one",
      runtimeSessionId: "session-one",
      rootStreamId: fixture.stream,
      activeStreamId: fixture.stream,
      linkedBy: fixture.author,
    })
  })

  test("should create a source-less visible session and one durable start for concurrent requests", async () => {
    const [first, second, alias] = await Promise.all([
      service().adoptRuntimeRun(params()),
      service().adoptRuntimeRun(params()),
      service().adoptRuntimeRun(params("attachment-two")),
    ])
    expect([second.id, alias.id]).toEqual([first.id, first.id])
    expect(first).toMatchObject({
      trigger: "runtime-origin",
      sourceMessageId: null,
      status: "claimed",
      claimedSourceMessageRevision: 0,
    })
    expect(await AgentSessionRepository.findById(fixture.pool, fixture.workspace, first.id)).toMatchObject({
      id: first.id,
      triggerMessageId: null,
      status: "running",
      streamId: fixture.stream,
    })
    const events = await fixture.pool.query("SELECT event_type, payload FROM stream_events WHERE workspace_id = $1", [
      fixture.workspace,
    ])
    expect(events.rows).toEqual([
      {
        event_type: "agent_session:started",
        payload: expect.objectContaining({ sessionId: first.id, triggerMessageId: null }),
      },
    ])
    const remaining = await fixture.pool.query("SELECT id FROM messages WHERE workspace_id = $1", [fixture.workspace])
    expect(remaining.rows).toEqual([])
  })

  test("should return a source-free claim through the adoption API", async () => {
    const handlers = createPublicApiHandlers({
      pool: fixture.pool,
      botRuntimeService: service(),
    } as Parameters<typeof createPublicApiHandlers>[0])
    let response: unknown
    await handlers.adoptBotRuntimeRun(
      {
        workspaceId: fixture.workspace,
        botApiKey: { botId: fixture.bot },
        body: params(),
      } as unknown as Request,
      {
        locals: {},
        json: (body: unknown) => {
          response = body
        },
      } as unknown as Response
    )
    expect(response).toMatchObject({
      data: {
        status: "claimed",
        invocation: {
          trigger: "runtime-origin",
          sourceMessageId: null,
          sourceRevision: 0,
          promptMarkdown: "",
          mentionedActorSlugs: [],
          responseStreamId: fixture.stream,
          claimToken: expect.any(String),
        },
      },
    })
  })

  test("should record trace and renew through the existing shared write operations", async () => {
    const invocation = await service().adoptRuntimeRun(params())
    const callback = {
      workspaceId: fixture.workspace,
      botId: fixture.bot,
      invocationId: invocation.id,
      instanceId: "runtime-one",
      claimToken: invocation.claimToken!,
    }
    await writes().recordSteps({
      ...callback,
      steps: [{ stepType: "thinking", content: "Following existing work", clientStepId: "step-one" }],
    })
    expect(await writes().renewClaim({ ...callback, claimTtlSeconds: 60, knownSourceRevision: 0 })).toMatchObject({
      invocationId: invocation.id,
      status: "active",
      sourceRevision: 0,
    })
    expect(await AgentSessionRepository.findStepsBySession(fixture.pool, fixture.workspace, invocation.id)).toEqual([
      expect.objectContaining({ stepType: "thinking", content: expect.anything() }),
    ])
  })

  test("should retain terminal request aliases and permit a fresh attachment to the same run", async () => {
    const invocation = await service().adoptRuntimeRun(params())
    await service().adoptRuntimeRun(params("attachment-two"))
    const handlers = createPublicApiHandlers({
      pool: fixture.pool,
      io,
      botRuntimeService: service(),
      botRuntimeWriteOps: writes(),
      botChannelService: new BotChannelService({ pool: fixture.pool }),
      eventService: new EventService(fixture.pool),
    } as Parameters<typeof createPublicApiHandlers>[0])
    let response: unknown
    await handlers.completeBotInvocation(
      {
        workspaceId: fixture.workspace,
        botApiKey: { botId: fixture.bot },
        params: { invocationId: invocation.id },
        body: {
          instanceId: "runtime-one",
          claimToken: invocation.claimToken!,
          sourceRevision: 0,
          finalMessageMarkdown: "Existing runtime work completed",
        },
      } as unknown as Request,
      {
        json: (value: unknown) => {
          response = value
        },
      } as Response
    )
    expect(response).toMatchObject({
      data: { invocationId: invocation.id, message: { content: "Existing runtime work completed" } },
    })
    expect(await AgentSessionRepository.findById(fixture.pool, fixture.workspace, invocation.id)).toMatchObject({
      status: "completed",
    })
    const completedEvents = await fixture.pool.query(
      "SELECT payload FROM stream_events WHERE workspace_id = $1 AND event_type = 'agent_session:completed'",
      [fixture.workspace]
    )
    expect(completedEvents.rows).toEqual([{ payload: expect.objectContaining({ sessionId: invocation.id }) }])
    expect(await service().adoptRuntimeRun(params("attachment-two"))).toMatchObject({
      id: invocation.id,
      status: "completed",
    })
    const next = await service().adoptRuntimeRun(params("attachment-three"))
    expect(next.id).not.toBe(invocation.id)
    expect(next).toMatchObject({ status: "claimed", sourceMessageId: null })
    expect(
      await withTransaction(fixture.pool, (db) =>
        service().findActiveClaimForUpdate(db, {
          workspaceId: fixture.workspace,
          botId: fixture.bot,
          invocationId: next.id,
          instanceId: "runtime-one",
          claimToken: invocation.claimToken!,
        })
      )
    ).toBeNull()
  })

  test("should recover an expired attachment with a fresh claim and fence the old token", async () => {
    const old = await service().adoptRuntimeRun(params())
    await fixture.pool.query(
      "UPDATE bot_invocations SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [old.id]
    )
    const recovered = await service().adoptRuntimeRun(params())
    expect(recovered).toMatchObject({ id: old.id, status: "claimed", attempts: 2 })
    expect(recovered.claimToken).not.toBe(old.claimToken)
    expect(
      await withTransaction(fixture.pool, (db) =>
        service().findActiveClaimForUpdate(db, {
          workspaceId: fixture.workspace,
          botId: fixture.bot,
          invocationId: old.id,
          instanceId: "runtime-one",
          claimToken: old.claimToken!,
        })
      )
    ).toBeNull()
  })

  test.each([false, true])("should recover a rebound runtime's attachment with expiry=%s", async (expired) => {
    const old = await service().adoptRuntimeRun(params())
    const link = await BotRuntimeSessionLinkRepository.findActiveByRuntimeSession(fixture.pool, params())
    await service().rebindPiRemoteSessionInstance({
      ...params(),
      linkId: link!.id,
      newInstanceId: "runtime-two",
    })
    if (expired)
      await fixture.pool.query(
        "UPDATE bot_invocations SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
        [old.id]
      )
    const recovered = await service().adoptRuntimeRun({ ...params(), instanceId: "runtime-two" })
    expect(recovered).toMatchObject({
      id: old.id,
      status: "claimed",
      claimedByInstanceId: "runtime-two",
      claimedRuntimeSessionId: "session-one",
    })
    await writes().recordSteps({
      workspaceId: fixture.workspace,
      botId: fixture.bot,
      invocationId: recovered.id,
      instanceId: "runtime-two",
      claimToken: recovered.claimToken!,
      steps: [{ stepType: "thinking", content: "Following after transfer", clientStepId: "transferred" }],
    })
    await expect(
      writes().recordSteps({
        workspaceId: fixture.workspace,
        botId: fixture.bot,
        invocationId: old.id,
        instanceId: "runtime-one",
        claimToken: old.claimToken!,
        steps: [{ stepType: "thinking", content: "Stale owner" }],
      })
    ).rejects.toMatchObject({ status: 404 })
    expect(await AgentSessionRepository.findStepsBySession(fixture.pool, fixture.workspace, old.id)).toEqual([
      expect.objectContaining({ stepType: "thinking", content: "Following after transfer" }),
    ])
  })

  test("should roll back adoption while another session owns this bot's stream", async () => {
    await AgentSessionRepository.insertRunningOrSkip(fixture.pool, {
      id: "session_other_work",
      workspaceId: fixture.workspace,
      streamId: fixture.stream,
      personaId: fixture.bot,
      triggerMessageId: "msg_other",
      initialSequence: 0n,
    })
    await expect(service().adoptRuntimeRun(params())).rejects.toMatchObject({ code: "RUNTIME_ATTACHMENT_SESSION_BUSY" })
    const remaining = await fixture.pool.query("SELECT id FROM bot_invocations WHERE workspace_id = $1", [
      fixture.workspace,
    ])
    expect(remaining.rows).toEqual([])
  })

  test("should park an exhausted expired attachment and preserve its terminal request identity", async () => {
    const invocation = await service().adoptRuntimeRun(params())
    await fixture.pool.query(
      "UPDATE bot_invocations SET attempts = 5, claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [invocation.id]
    )
    expect(await service().adoptRuntimeRun(params())).toMatchObject({ id: invocation.id, status: "parked" })
    expect(await service().adoptRuntimeRun(params())).toMatchObject({ id: invocation.id, status: "parked" })
    expect(await AgentSessionRepository.findById(fixture.pool, fixture.workspace, invocation.id)).toMatchObject({
      status: "failed",
    })
    expect(await service().adoptRuntimeRun(params("attachment-new"))).toMatchObject({ status: "claimed" })
  })

  test("should reject callbacks when a link is replaced by another runtime identity", async () => {
    const invocation = await service().adoptRuntimeRun(params())
    await fixture.pool.query(
      "UPDATE bot_runtime_session_links SET instance_id = 'replacement' WHERE workspace_id = $1",
      [fixture.workspace]
    )
    await expect(
      writes().recordSteps({
        workspaceId: fixture.workspace,
        botId: fixture.bot,
        invocationId: invocation.id,
        instanceId: "runtime-one",
        claimToken: invocation.claimToken!,
        steps: [{ stepType: "thinking", content: "stale owner" }],
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  test("should reject reusing an attachment identity for another external run", async () => {
    await service().adoptRuntimeRun(params())
    await expect(service().adoptRuntimeRun({ ...params(), externalRunId: "another-run" })).rejects.toMatchObject({
      code: "RUNTIME_ATTACHMENT_CONFLICT",
    })
  })

  test("should reject a wrong bot or runtime session and an unrelated response stream", async () => {
    await expect(service().adoptRuntimeRun({ ...params(), botId: "bot_wrong" })).rejects.toBeDefined()
    await expect(service().adoptRuntimeRun({ ...params(), runtimeSessionId: "session_wrong" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const other = streamId()
    await fixture.pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [other, fixture.workspace, fixture.author]
    )
    await expect(service().adoptRuntimeRun({ ...params(), responseStreamId: other })).rejects.toBeDefined()
  })

  test("should cancel attachment sessions when their runtime link ends and reject late trace", async () => {
    const invocation = await service().adoptRuntimeRun(params())
    await service().endRuntimeSession(params())
    expect(await AgentSessionRepository.findById(fixture.pool, fixture.workspace, invocation.id)).toMatchObject({
      status: "superseded",
    })
    await expect(
      writes().recordSteps({
        workspaceId: fixture.workspace,
        botId: fixture.bot,
        invocationId: invocation.id,
        instanceId: "runtime-one",
        claimToken: invocation.claimToken!,
        steps: [{ stepType: "thinking", content: "late" }],
      })
    ).rejects.toMatchObject({ status: 404 })
  })

  test("should let link termination finish while renewal waits for its link lock", async () => {
    const invocation = await service().adoptRuntimeRun(params())
    const ending = await fixture.pool.connect()
    const renewing = await fixture.pool.connect()
    let renewal: Promise<unknown> | undefined
    try {
      await ending.query("BEGIN")
      await renewing.query("BEGIN")
      await BotRuntimeSessionLinkRepository.endActiveByRuntimeSession(ending, params())
      const {
        rows: [{ pid }],
      } = await renewing.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      renewal = service().renewInvocationClaimInTransaction(renewing, {
        ...params(),
        invocationId: invocation.id,
        claimToken: invocation.claimToken!,
      })
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const result = await ending.query<{ waiting: boolean }>(
          "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
          [pid]
        )
        waiting = result.rows[0]?.waiting === true
        if (!waiting) await Bun.sleep(10)
      }
      expect(waiting).toBe(true)
      await BotInvocationRepository.cancelActiveByTargetRuntimeSession(ending, params())
      await ending.query("COMMIT")
      expect(await renewal).toBeNull()
      await renewing.query("COMMIT")
    } finally {
      await ending.query("ROLLBACK")
      await renewal?.catch(() => undefined)
      await renewing.query("ROLLBACK")
      ending.release()
      renewing.release()
    }
  })

  test("should reject encrypted adoption before writing any session", async () => {
    await E2eStreamsRepository.markStreamE2e(fixture.pool, {
      streamId: fixture.stream,
      workspaceId: fixture.workspace,
      ownerUserId: fixture.author,
      ownerUserKeyId: "key-owner",
    })
    await expect(service().adoptRuntimeRun(params())).rejects.toMatchObject({
      code: "ENCRYPTED_RUNTIME_ADOPTION_UNSUPPORTED",
    })
    const remaining = await fixture.pool.query("SELECT id FROM agent_sessions WHERE workspace_id = $1", [
      fixture.workspace,
    ])
    expect(remaining.rows).toEqual([])
  })

  test("should permit a child thread only under its linked root", async () => {
    const child = streamId()
    await fixture.pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by, root_stream_id, parent_stream_id, parent_anchor_id) VALUES ($1, $2, 'thread', 'private', $3, $4, $4, 'msg_anchor')",
      [child, fixture.workspace, fixture.author, fixture.stream]
    )
    expect(await service().adoptRuntimeRun({ ...params(), responseStreamId: child })).toMatchObject({
      responseStreamId: child,
      sourceMessageId: null,
    })
  })

  test("should reject creation after archive", async () => {
    await fixture.pool.query("UPDATE streams SET archived_at = NOW() WHERE id = $1", [fixture.stream])
    await expect(service().adoptRuntimeRun(params())).rejects.toMatchObject({ code: "STREAM_READ_ONLY" })
  })
})
