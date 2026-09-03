import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { AgentSessionRepository } from "../../src/features/agents"
import { BotInvocationRepository, BotRuntimeService, buildEditedSourcePrompt } from "../../src/features/bot-runtimes"
import { MessageRepository, MessageVersionRepository } from "../../src/features/messaging"
import { messageId, messageVersionId, workspaceId } from "../../src/lib/id"

describe("bot invocation canonical source mutations", () => {
  let sourceSequence = 0n
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let stream: string
  let author: string
  let bot: string
  const instance = `source-test-${crypto.randomUUID().slice(0, 8)}`
  const service = () => new BotRuntimeService({ pool })

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "invocation_mutations", instanceIds: [instance] })
    ;({ pool, workspace, stream, author, bot } = fixture)
  }, 30_000)

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = $1", [stream])
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
  })

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  function mentionContent() {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: bot, slug: "source-test-bot", mentionType: "bot" } }],
        },
      ],
    }
  }

  async function source(markdown = "one") {
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: stream,
      sequence: ++sourceSequence,
      authorId: author,
      authorType: "user",
      contentJson: testContentJson(markdown),
      contentMarkdown: markdown,
    })
  }

  async function invocation(
    sourceMessageId: string,
    revision: number,
    id = `binv_${crypto.randomUUID().replaceAll("-", "")}`,
    trigger: "active-scratchpad" | "mention" | "session-control" = "active-scratchpad",
    actorId = bot
  ) {
    let requiredCapability: "mentionable" | "session-control" | "active-scratchpad" = "active-scratchpad"
    if (trigger === "mention") requiredCapability = "mentionable"
    if (trigger === "session-control") requiredCapability = "session-control"
    return BotInvocationRepository.insertIdempotent(pool, {
      id,
      workspaceId: workspace,
      rootStreamId: stream,
      activeStreamId: stream,
      sourceMessageId,
      responseStreamId: stream,
      actorType: "bot",
      actorId,
      trigger,
      requiredCapability,
      promptMarkdown: "cached",
      sourceMessageRevision: revision,
      authorUserId: author,
      mentionedActorSlugs: [],
      targetInstanceId: null,
      targetRuntimeSessionId: null,
      metadata: {},
    })
  }

  test("embedded steer edit reconciles only its companion and deletion cancels both", async () => {
    const message = await source("before")
    const companion = await invocation(message.id, message.revision)
    const control = await invocation(message.id, 0, undefined, "session-control")

    await MessageRepository.updateContent(pool, message.id, testContentJson("after"), "after")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })

    const afterEdit = await pool.query<{
      id: string
      trigger: string
      status: string
      source_message_revision: number
    }>(
      `SELECT id, trigger, status, source_message_revision FROM bot_invocations
       WHERE workspace_id = $1 AND source_message_id = $2 ORDER BY trigger, source_message_revision`,
      [workspace, message.id]
    )
    expect(afterEdit.rows).toEqual([
      {
        id: companion.invocation.id,
        trigger: "active-scratchpad",
        status: "pending",
        source_message_revision: 2,
      },
      { id: control.invocation.id, trigger: "session-control", status: "pending", source_message_revision: 0 },
    ])

    await MessageRepository.softDelete(pool, message.id)
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    const afterDelete = await pool.query<{ trigger: string; status: string }>(
      `SELECT trigger, status FROM bot_invocations
       WHERE workspace_id = $1 AND source_message_id = $2 AND status <> 'cancelled'`,
      [workspace, message.id]
    )
    expect(afterDelete.rows).toEqual([])
  })

  test.each(["running", "completed"] as const)(
    "deleting the source after completion ends the %s late-delivery session without cancelling the turn",
    async (sessionStatus) => {
      const message = await source("done")
      const completed = await invocation(message.id, message.revision)
      await AgentSessionRepository.insert(pool, {
        id: completed.invocation.id,
        streamId: stream,
        personaId: bot,
        triggerMessageId: message.id,
        status: sessionStatus,
      })
      await pool.query("UPDATE bot_invocations SET status = 'completed' WHERE id = $1", [completed.invocation.id])

      await MessageRepository.softDelete(pool, message.id)
      await new BotRuntimeService({ pool }).reconcileInvocationSource({
        workspaceId: workspace,
        sourceMessageId: message.id,
      })

      const session = await AgentSessionRepository.findById(pool, completed.invocation.id)
      const row = await pool.query<{ status: string; cancellation_reason: string | null }>(
        "SELECT status, cancellation_reason FROM bot_invocations WHERE id = $1",
        [completed.invocation.id]
      )
      const deletedEvents = await pool.query<{ payload: { sessionId: string } }>(
        "SELECT payload FROM stream_events WHERE stream_id = $1 AND event_type = 'agent_session:deleted' AND payload->>'sessionId' = $2",
        [stream, completed.invocation.id]
      )
      expect({
        session: session?.status,
        invocation: row.rows[0],
        deletedSessionIds: deletedEvents.rows.map((event) => event.payload.sessionId),
      }).toEqual({
        session: "deleted",
        invocation: { status: "completed", cancellation_reason: null },
        deletedSessionIds: [completed.invocation.id],
      })
    }
  )

  test("repository edits and deletion advance the canonical revision once", async () => {
    const created = await source()
    const first = await MessageRepository.updateContent(pool, created.id, testContentJson("two"), "two")
    const second = await MessageRepository.updateContent(pool, created.id, testContentJson("three"), "three")
    const deleted = await MessageRepository.softDelete(pool, created.id)
    const repeatedDelete = await MessageRepository.softDelete(pool, created.id)
    expect([
      created.revision,
      first?.revision,
      second?.revision,
      deleted?.revision,
      repeatedDelete,
      await MessageVersionRepository.getCurrentRevision(pool, created.id),
    ]).toEqual([1, 2, 3, 4, null, 4])
  })

  test("canonical reconciliation refreshes pending prompt and revision from the locked source", async () => {
    const message = await source("before")

    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    await MessageRepository.updateContent(pool, message.id, testContentJson("after"), "after")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })

    const rows = await pool.query<{ prompt_markdown: string; source_message_revision: number; status: string }>(
      `SELECT prompt_markdown, source_message_revision, status
       FROM bot_invocations WHERE workspace_id = $1 AND source_message_id = $2`,
      [workspace, message.id]
    )
    expect(rows.rows).toEqual([{ prompt_markdown: "after", source_message_revision: 2, status: "pending" }])
  })

  test("an edit after a completed turn dispatches a fresh invocation carrying the answered wording", async () => {
    const message = await source("before")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    await pool.query(
      "UPDATE bot_invocations SET status = 'completed' WHERE workspace_id = $1 AND source_message_id = $2",
      [workspace, message.id]
    )

    await MessageVersionRepository.insert(pool, {
      id: messageVersionId(),
      messageId: message.id,
      contentJson: testContentJson("before"),
      contentMarkdown: "before",
      editedBy: author,
    })
    await MessageRepository.updateContent(pool, message.id, testContentJson("after"), "after")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })

    const rows = await pool.query<{ status: string; source_message_revision: number; prompt_markdown: string }>(
      `SELECT status, source_message_revision, prompt_markdown FROM bot_invocations
       WHERE workspace_id = $1 AND source_message_id = $2 ORDER BY source_message_revision`,
      [workspace, message.id]
    )
    const framed = buildEditedSourcePrompt("after", {
      previousMarkdown: "before",
      previousRevision: 1,
      currentRevision: 2,
    })
    expect(rows.rows).toEqual([
      { status: "completed", source_message_revision: 1, prompt_markdown: "before" },
      { status: "pending", source_message_revision: 2, prompt_markdown: framed },
    ])

    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "edit-rerun",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect({ prompt: claimed?.promptMarkdown, revision: claimed?.claimedSourceMessageRevision }).toEqual({
      prompt: framed,
      revision: 2,
    })
  })

  test("stale failure and parking cannot terminalize edited work before canonical reclaim", async () => {
    const message = await source("before")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "stale-failure",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).not.toBeNull()

    await MessageRepository.updateContent(pool, message.id, testContentJson("after"), "after")
    expect(
      await service().failInvocation({
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "stale-failure",
        errorMessage: "runtime failed stale work",
      })
    ).toBeNull()

    await pool.query(
      "UPDATE bot_invocations SET attempts = $2, claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [claimed!.id, 5]
    )
    expect(
      await BotInvocationRepository.parkExhausted(pool, {
        workspaceId: workspace,
        botId: bot,
        maxAttempts: 5,
      })
    ).toEqual([])

    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    const refreshed = await pool.query<{
      source_message_revision: number
      claimed_source_message_revision: number
      attempts: number
      prompt_markdown: string
      status: string
    }>(
      `SELECT source_message_revision, claimed_source_message_revision, attempts, prompt_markdown, status
       FROM bot_invocations WHERE id = $1`,
      [claimed!.id]
    )
    expect(refreshed.rows[0]).toEqual({
      source_message_revision: 2,
      claimed_source_message_revision: 1,
      attempts: 0,
      prompt_markdown: "before",
      status: "claimed",
    })

    const reclaimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "fresh-after-edit",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect({ revision: reclaimed?.claimedSourceMessageRevision, prompt: reclaimed?.promptMarkdown }).toEqual({
      revision: 2,
      prompt: "after",
    })
  })

  test("an edit holding the message lock prevents stale failure and parking from committing", async () => {
    const failureMessage = await source("failure before")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: failureMessage.id })
    const failureClaim = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "failure-source-lock",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(failureClaim).not.toBeNull()

    const failureEditor = await pool.connect()
    await failureEditor.query("BEGIN")
    try {
      await MessageRepository.updateContent(
        failureEditor,
        failureMessage.id,
        testContentJson("failure after"),
        "failure after"
      )
      let failureSettled = false
      const failing = service()
        .failInvocation({
          workspaceId: workspace,
          botId: bot,
          invocationId: failureClaim!.id,
          instanceId: instance,
          claimToken: "failure-source-lock",
          errorMessage: "must not win after edit",
        })
        .finally(() => {
          failureSettled = true
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(failureSettled).toBe(false)
      await failureEditor.query("COMMIT")
      expect(await failing).toBeNull()
    } finally {
      await failureEditor.query("ROLLBACK").catch(() => {})
      failureEditor.release()
    }

    const parkingMessage = await source("parking before")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: parkingMessage.id })
    const parkingClaim = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "parking-source-lock",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(parkingClaim).not.toBeNull()
    await pool.query(
      "UPDATE bot_invocations SET attempts = $2, claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [parkingClaim!.id, 5]
    )

    const parkingEditor = await pool.connect()
    await parkingEditor.query("BEGIN")
    try {
      await MessageRepository.updateContent(
        parkingEditor,
        parkingMessage.id,
        testContentJson("parking after"),
        "parking after"
      )
      let parkingSettled = false
      const parking = BotInvocationRepository.parkExhausted(pool, {
        workspaceId: workspace,
        botId: bot,
        maxAttempts: 5,
      }).finally(() => {
        parkingSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(parkingSettled).toBe(false)
      await parkingEditor.query("COMMIT")
      expect(await parking).toEqual([])
    } finally {
      await parkingEditor.query("ROLLBACK").catch(() => {})
      parkingEditor.release()
    }

    const statuses = await pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM bot_invocations WHERE id = ANY($1) ORDER BY id",
      [[failureClaim!.id, parkingClaim!.id]]
    )
    expect(statuses.rows).toEqual([failureClaim!.id, parkingClaim!.id].sort().map((id) => ({ id, status: "claimed" })))
  })

  test("partial uniqueness allows a cancelled predecessor and one active replacement", async () => {
    const message = await source()
    const first = await invocation(message.id, message.revision)
    await BotInvocationRepository.cancelActiveBySource(pool, {
      workspaceId: workspace,
      sourceMessageId: message.id,
      reason: "routing_changed",
    })
    const replacement = await invocation(
      message.id,
      message.revision,
      `binv_${crypto.randomUUID().replaceAll("-", "")}`
    )
    const deduplicated = await invocation(
      message.id,
      message.revision,
      `binv_${crypto.randomUUID().replaceAll("-", "")}`
    )
    expect([
      first.wasNewlyInserted,
      replacement.wasNewlyInserted,
      deduplicated.wasNewlyInserted,
      deduplicated.invocation.id,
    ]).toEqual([true, true, false, replacement.invocation.id])
  })

  test("bot-session ownership lookup is workspace-scoped", async () => {
    const message = await source()
    const created = await invocation(message.id, message.revision)

    expect([
      await BotInvocationRepository.isBotInvocationSession(pool, workspace, created.invocation.id),
      await BotInvocationRepository.isBotInvocationSession(pool, workspaceId(), created.invocation.id),
    ]).toEqual([true, false])
  })

  test("terminal actors are excluded across trigger spelling while newly added actors remain eligible", async () => {
    const terminalStatuses = ["completed", "failed", "parked", "expired"] as const
    const results: Array<{
      status: string
      sameActorInserted: boolean
      sameActorStatus: string
      newActorInserted: boolean
    }> = []

    for (const status of terminalStatuses) {
      const message = await source(status)
      const terminal = await invocation(message.id, message.revision, undefined, "mention")
      await pool.query("UPDATE bot_invocations SET status = $1 WHERE id = $2", [status, terminal.invocation.id])
      const sameActor = await invocation(message.id, message.revision, undefined, "active-scratchpad")
      const newActor = await invocation(
        message.id,
        message.revision,
        undefined,
        "active-scratchpad",
        `bot_new_${status}`
      )
      results.push({
        status,
        sameActorInserted: sameActor.wasNewlyInserted,
        sameActorStatus: sameActor.invocation.status,
        newActorInserted: newActor.wasNewlyInserted,
      })
    }

    expect(results).toEqual(
      terminalStatuses.map((status) => ({
        status,
        sameActorInserted: false,
        sameActorStatus: status,
        newActorInserted: true,
      }))
    )
  })

  test("route reconciliation cancels removed pending routes", async () => {
    const message = await source()
    const active = await invocation(message.id, 1)
    const mention = await invocation(message.id, 1, `binv_${crypto.randomUUID().replaceAll("-", "")}`, "mention")
    const cancelled = await BotInvocationRepository.cancelActiveRoutesNotDesired(pool, {
      workspaceId: workspace,
      sourceMessageId: message.id,
      sourceMessageRevision: 2,
      desiredRoutes: [
        {
          actorType: "bot",
          actorId: bot,
          trigger: "mention",
          activeStreamId: stream,
          responseStreamId: stream,
          targetInstanceId: null,
          targetRuntimeSessionId: null,
        },
      ],
    })
    expect({ cancelled: cancelled.map((row) => row.id), mention: mention.invocation.status }).toEqual({
      cancelled: [active.invocation.id],
      mention: "pending",
    })
  })

  test("route-changing reconciliation and completion share source-first lock order", async () => {
    const message = await source("before")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "route-change-lock-order",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).not.toBeNull()
    expect(
      await AgentSessionRepository.insertRunningOrSkip(pool, {
        id: claimed!.id,
        streamId: stream,
        personaId: bot,
        triggerMessageId: message.id,
        triggerMessageRevision: 1,
        initialSequence: 0n,
      })
    ).not.toBeNull()
    await MessageRepository.updateContent(pool, message.id, mentionContent(), "@source-test-bot")

    const sessionBlocker = await pool.connect()
    const completer = await pool.connect()
    let blockerCommitted = false
    let completerFinished = false
    let reconciliation: Promise<unknown> | null = null
    let completion: Promise<unknown> | null = null
    try {
      await sessionBlocker.query("BEGIN")
      const blockerPid = await sessionBlocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      await sessionBlocker.query("SELECT id FROM agent_sessions WHERE id = $1 FOR UPDATE", [claimed!.id])

      reconciliation = service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
      const reconciliationWaitDeadline = Date.now() + 2_000
      for (;;) {
        const blocked = await pool.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity a
             WHERE $1 = ANY(pg_blocking_pids(a.pid))
           ) AS blocked`,
          [blockerPid.rows[0]!.pid]
        )
        if (blocked.rows[0]?.blocked) break
        if (Date.now() >= reconciliationWaitDeadline) {
          throw new Error("reconciliation did not reach the agent-session row barrier")
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      await completer.query("BEGIN")
      const completerPid = await completer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      completion = service()
        .findActiveClaimForUpdate(completer, {
          workspaceId: workspace,
          botId: bot,
          invocationId: claimed!.id,
          instanceId: instance,
          claimToken: "route-change-lock-order",
        })
        .then(async (active) => {
          await completer.query("COMMIT")
          completerFinished = true
          return active
        })
      const completionWaitDeadline = Date.now() + 2_000
      for (;;) {
        const waiting = await pool.query<{ waiting: boolean }>(
          `SELECT COALESCE(wait_event_type = 'Lock', FALSE) AS waiting
           FROM pg_stat_activity WHERE pid = $1`,
          [completerPid.rows[0]!.pid]
        )
        if (waiting.rows[0]?.waiting) break
        if (Date.now() >= completionWaitDeadline) throw new Error("completion did not reach the lock barrier")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      await sessionBlocker.query("COMMIT")
      blockerCommitted = true
      const result = await Promise.race([
        Promise.all([reconciliation, completion]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("route-change deadlock")), 4_000)),
      ])
      const rows = await pool.query<{ trigger: string; status: string }>(
        `SELECT trigger, status FROM bot_invocations
         WHERE workspace_id = $1 AND source_message_id = $2
         ORDER BY created_at, id`,
        [workspace, message.id]
      )
      expect({ lockedClaim: result[1], rows: rows.rows }).toEqual({
        lockedClaim: null,
        rows: [
          { trigger: "active-scratchpad", status: "cancelled" },
          { trigger: "mention", status: "pending" },
        ],
      })
    } finally {
      if (!blockerCommitted) await sessionBlocker.query("ROLLBACK").catch(() => {})
      if (!completerFinished) await completer.query("ROLLBACK").catch(() => {})
      sessionBlocker.release()
      completer.release()
      await reconciliation?.catch(() => {})
      await completion?.catch(() => {})
    }
  })

  test("edit-before-claim blocks on the source lock and hands out only the edited revision", async () => {
    const message = await source("before")
    await invocation(message.id, message.revision)
    const editor = await pool.connect()
    let committed = false
    try {
      await editor.query("BEGIN")
      await MessageRepository.updateContent(editor, message.id, testContentJson("after"), "after")
      let settled = false
      const claiming = service()
        .claimNextInvocation({
          workspaceId: workspace,
          botId: bot,
          instanceId: instance,
          runtimeKind: "openclaw",
          claimToken: "edit-before-claim",
          supportedCapabilities: ["active-scratchpad"],
          claimTtlSeconds: 60,
        })
        .finally(() => {
          settled = true
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(settled).toBe(false)
      await editor.query("COMMIT")
      committed = true

      const claimed = await claiming
      expect({ revision: claimed?.claimedSourceMessageRevision, prompt: claimed?.promptMarkdown }).toEqual({
        revision: 2,
        prompt: "after",
      })
    } finally {
      if (!committed) await editor.query("ROLLBACK").catch(() => {})
      editor.release()
    }
  })

  test("two invalid sibling claims cancel only their own candidates without deadlock", async () => {
    const otherBot = `bot_other_${crypto.randomUUID().slice(0, 8)}`
    const otherInstance = `other-${crypto.randomUUID().slice(0, 8)}`
    await pool.query(
      `INSERT INTO bot_runtime_instances (id, workspace_id, bot_id, instance_id, runtime_kind, status, accepting_invocations)
       VALUES ($1, $2, $3, $4, 'openclaw', 'available', TRUE)`,
      [`bri_${crypto.randomUUID().replaceAll("-", "")}`, workspace, otherBot, otherInstance]
    )
    const message = await source("gone")
    const first = await invocation(message.id, message.revision)
    const second = await invocation(message.id, message.revision, undefined, "active-scratchpad", otherBot)
    await MessageRepository.softDelete(pool, message.id)

    const claims = Promise.all([
      service().claimNextInvocation({
        workspaceId: workspace,
        botId: bot,
        instanceId: instance,
        runtimeKind: "openclaw",
        claimToken: "invalid-1",
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 60,
      }),
      service().claimNextInvocation({
        workspaceId: workspace,
        botId: otherBot,
        instanceId: otherInstance,
        runtimeKind: "openclaw",
        claimToken: "invalid-2",
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 60,
      }),
    ])
    const result = await Promise.race([
      claims,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("claim deadlock")), 2_000)),
    ])
    const statuses = await pool.query<{ id: string; status: string; cancellation_reason: string }>(
      "SELECT id, status, cancellation_reason FROM bot_invocations WHERE id = ANY($1) ORDER BY id",
      [[first.invocation.id, second.invocation.id]]
    )

    expect({ claims: result, rows: statuses.rows }).toEqual({
      claims: [null, null],
      rows: [first.invocation.id, second.invocation.id]
        .sort()
        .map((id) => ({ id, status: "cancelled", cancellation_reason: "source_deleted" })),
    })
  })

  test("completion blocks reconciliation insertion and prevents duplicate availability", async () => {
    const message = await source("complete once")
    await invocation(message.id, message.revision)
    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "completion-vs-reconciliation",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).not.toBeNull()

    const outboxFloor = await pool.query<{ id: string }>("SELECT COALESCE(MAX(id), 0)::text AS id FROM outbox")
    const waiterBaseline = await pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND NOT granted
    `)
    const completer = await pool.connect()
    let committed = false
    let reconciliation: Promise<unknown> | null = null
    try {
      await completer.query("BEGIN")
      const locked = await service().findActiveClaimForUpdate(completer, {
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "completion-vs-reconciliation",
      })
      expect(locked).not.toBeNull()

      reconciliation = service().reconcileInvocationSource({
        workspaceId: workspace,
        sourceMessageId: message.id,
      })
      const expectedWaiters = Number(waiterBaseline.rows[0]!.count) + 1
      const waitDeadline = Date.now() + 2_000
      for (;;) {
        const waiters = await pool.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND NOT granted
        `)
        if (Number(waiters.rows[0]!.count) >= expectedWaiters) break
        if (Date.now() >= waitDeadline) throw new Error("reconciliation did not reach the actor-source lock barrier")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      const completed = await service().completeInvocationInTransaction(completer, {
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "completion-vs-reconciliation",
        sourceRevision: claimed!.claimedSourceMessageRevision!,
      })
      await completer.query("COMMIT")
      committed = true
      await reconciliation

      const rows = await pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM bot_invocations
         WHERE workspace_id = $1 AND source_message_id = $2
         ORDER BY id`,
        [workspace, message.id]
      )
      const duplicateAvailability = await pool.query<{ invocation_id: string }>(
        `SELECT payload->>'invocationId' AS invocation_id
         FROM outbox
         WHERE id > $1
           AND event_type = 'bot_invocation:available'
           AND payload->>'workspaceId' = $2
           AND payload->>'botId' = $3
         ORDER BY id`,
        [outboxFloor.rows[0]!.id, workspace, bot]
      )
      expect({
        completed: completed?.status,
        rows: rows.rows,
        duplicateAvailability: duplicateAvailability.rows,
      }).toEqual({
        completed: "completed",
        rows: [{ id: claimed!.id, status: "completed" }],
        duplicateAvailability: [],
      })
    } finally {
      if (!committed) await completer.query("ROLLBACK").catch(() => {})
      completer.release()
      await reconciliation?.catch(() => {})
    }
  })

  test("completion-before-edit wins the source lock and remains a completed-turn mutation", async () => {
    const message = await source("before")
    await invocation(message.id, message.revision)
    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "completion-first",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).not.toBeNull()

    const completer = await pool.connect()
    try {
      await completer.query("BEGIN")
      const locked = await service().findActiveClaimForUpdate(completer, {
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "completion-first",
      })
      expect(locked && (await service().validateClaimSourceForCompletion(completer, locked))).toBe(true)
      let editSettled = false
      const editing = MessageRepository.updateContent(pool, message.id, testContentJson("after"), "after").finally(
        () => {
          editSettled = true
        }
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(editSettled).toBe(false)
      const completed = await service().completeInvocationInTransaction(completer, {
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "completion-first",
        sourceRevision: claimed!.claimedSourceMessageRevision!,
      })
      await completer.query("COMMIT")
      expect({ completed: completed?.status, edited: (await editing)?.revision }).toEqual({
        completed: "completed",
        edited: 2,
      })
    } finally {
      await completer.query("ROLLBACK").catch(() => {})
      completer.release()
    }
  })

  test("edit-before-completion makes the locked production completion fence reject", async () => {
    const message = await source("before")
    await invocation(message.id, message.revision)
    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeKind: "openclaw",
      claimToken: "edit-first",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).not.toBeNull()

    const editor = await pool.connect()
    await editor.query("BEGIN")
    try {
      await MessageRepository.updateContent(editor, message.id, testContentJson("after"), "after")
      let completionSettled = false
      const completion = (async () => {
        const completer = await pool.connect()
        try {
          await completer.query("BEGIN")
          const locked = await service().findActiveClaimForUpdate(completer, {
            workspaceId: workspace,
            botId: bot,
            invocationId: claimed!.id,
            instanceId: instance,
            claimToken: "edit-first",
          })
          const valid = Boolean(locked && (await service().validateClaimSourceForCompletion(completer, locked)))
          await completer.query("ROLLBACK")
          return valid
        } finally {
          completer.release()
        }
      })().finally(() => {
        completionSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(completionSettled).toBe(false)
      await editor.query("COMMIT")
      const fenceAccepted = await completion
      const persisted = await pool.query<{ status: string }>("SELECT status FROM bot_invocations WHERE id = $1", [
        claimed!.id,
      ])
      expect({ fenceAccepted, status: persisted.rows[0]?.status }).toEqual({
        fenceAccepted: false,
        status: "claimed",
      })
    } finally {
      await editor.query("ROLLBACK").catch(() => {})
      editor.release()
    }
  })
})
