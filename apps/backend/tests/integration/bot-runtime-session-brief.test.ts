import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { BotRuntimeSessionLinkRepository, BotRuntimeService } from "../../src/features/bot-runtimes"
import { StreamService } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { botRuntimeSessionLinkId, messageId } from "../../src/lib/id"

describe("briefRuntimeSession", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  const service = () => new BotRuntimeService({ pool, streamService: new StreamService(pool) })

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({
      label: "session_brief",
      instanceIds: ["target-instance", "sibling-instance"],
    })
    ;({ pool, workspace, stream: root, author, bot } = fixture)
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  beforeEach(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM messages WHERE stream_id = $1", [root])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1 AND id <> $2", [workspace, root])
  })

  let sequence = 0n
  async function anchorMessage(markdown = "anchor message") {
    sequence += 1n
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: root,
      sequence,
      authorId: author,
      authorType: "user",
      contentJson: testContentJson(markdown),
      contentMarkdown: markdown,
    })
  }

  async function attachThread(instanceId: string, runtimeSessionId: string) {
    const anchor = await anchorMessage()
    const attached = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      runtimeKind: "openclaw",
      instanceId,
      runtimeSessionId,
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })
    return { ...attached, anchor }
  }

  test("briefs the thread session on its anchor message and writes no message of its own", async () => {
    const { link, stream: thread, anchor } = await attachThread("target-instance", "target-session")

    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentMarkdown: "brief content",
    })

    expect(briefed).not.toBeNull()
    expect(briefed!.invocation).toMatchObject({
      workspaceId: workspace,
      rootStreamId: root,
      activeStreamId: root,
      sourceMessageId: anchor.id,
      responseStreamId: thread.id,
      actorType: "bot",
      actorId: bot,
      trigger: "brief",
      requiredCapability: "active-scratchpad",
      status: "pending",
      promptMarkdown: "brief content",
      authorUserId: author,
      targetInstanceId: link.instanceId,
      targetRuntimeSessionId: link.runtimeSessionId,
    })

    const written = await pool.query<{ count: string }>("SELECT count(*)::text FROM messages WHERE stream_id = $1", [
      thread.id,
    ])
    expect(written.rows[0]!.count).toBe("0")
  })

  test("the briefed invocation is claimable only by the targeted identity", async () => {
    await attachThread("target-instance", "target-session")
    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentMarkdown: "brief content",
    })
    expect(briefed).not.toBeNull()

    const claimParams = {
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "openclaw" as const,
      claimTtlSeconds: 60,
      supportedCapabilities: ["active-scratchpad" as const],
    }

    const bySibling = await service().claimNextInvocation({
      ...claimParams,
      instanceId: "sibling-instance",
      runtimeSessionId: "target-session",
      claimToken: "claim-sibling",
    })
    expect(bySibling).toBeNull()

    const byWrongSession = await service().claimNextInvocation({
      ...claimParams,
      instanceId: "target-instance",
      runtimeSessionId: "some-other-session",
      claimToken: "claim-wrong-session",
    })
    expect(byWrongSession).toBeNull()

    const byTarget = await service().claimNextInvocation({
      ...claimParams,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      claimToken: "claim-target",
    })
    expect(byTarget).toMatchObject({ id: briefed!.invocation.id, status: "claimed" })
  })

  test("the targeted runtime claims a brief, keeps the caller's prompt, and completes it", async () => {
    await attachThread("target-instance", "target-session")
    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentMarkdown: "brief content",
    })
    expect(briefed).not.toBeNull()

    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "openclaw",
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      claimToken: "claim-target",
      claimTtlSeconds: 60,
      supportedCapabilities: ["active-scratchpad"],
    })
    expect(claimed).toMatchObject({ id: briefed!.invocation.id, status: "claimed", promptMarkdown: "brief content" })

    const pin = await pool.query<{ claimed_source_message_revision: number | null }>(
      "SELECT claimed_source_message_revision FROM bot_invocations WHERE workspace_id = $1 AND id = $2",
      [workspace, briefed!.invocation.id]
    )
    const revision = pin.rows[0]!.claimed_source_message_revision
    expect(revision).not.toBeNull()

    const completed = await service().completeInvocation({
      workspaceId: workspace,
      botId: bot,
      invocationId: briefed!.invocation.id,
      instanceId: "target-instance",
      claimToken: "claim-target",
      sourceRevision: revision!,
    })
    expect(completed).toMatchObject({ id: briefed!.invocation.id, status: "completed" })
  })

  test("the brief waits on a locked link so a concurrent end cannot strand it", async () => {
    await attachThread("target-instance", "target-session")
    const holder = await pool.connect()
    let settled = false
    try {
      await holder.query("BEGIN")
      await holder.query(
        "SELECT id FROM bot_runtime_session_links WHERE workspace_id = $1 AND runtime_session_id = $2 FOR UPDATE",
        [workspace, "target-session"]
      )
      const brief = service()
        .briefRuntimeSession({
          workspaceId: workspace,
          botId: bot,
          ownerUserId: author,
          instanceId: "target-instance",
          runtimeSessionId: "target-session",
          contentMarkdown: "brief content",
        })
        .then((result) => {
          settled = true
          return result
        })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(settled).toBe(false)
      await holder.query("ROLLBACK")
      expect(await brief).not.toBeNull()
    } finally {
      holder.release()
    }
  })

  test("the outbox route reconcile leaves the brief invocation pending", async () => {
    const { anchor } = await attachThread("target-instance", "target-session")
    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentMarkdown: "brief content",
    })
    expect(briefed).not.toBeNull()

    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: anchor.id })

    const row = await pool.query<{ status: string; cancellation_reason: string | null }>(
      "SELECT status, cancellation_reason FROM bot_invocations WHERE workspace_id = $1 AND id = $2",
      [workspace, briefed!.invocation.id]
    )
    expect(row.rows[0]).toEqual({ status: "pending", cancellation_reason: null })
  })

  test("refuses a link whose active stream is not a message thread", async () => {
    // A scratchpad session (`createLinkedScratchpadSession`) links the root to
    // itself, so there is no anchor message to source the turn from.
    await BotRuntimeSessionLinkRepository.upsert(pool, {
      id: botRuntimeSessionLinkId(),
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "openclaw",
      instanceId: "target-instance",
      runtimeSessionId: "rootlinked-session",
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })

    await expect(
      service().briefRuntimeSession({
        workspaceId: workspace,
        botId: bot,
        ownerUserId: author,
        instanceId: "target-instance",
        runtimeSessionId: "rootlinked-session",
        contentMarkdown: "brief content",
      })
    ).rejects.toMatchObject({ status: 400, code: "SESSION_NOT_MESSAGE_ANCHORED" })
  })

  test("returns null and creates no invocation for an ended or unknown identity", async () => {
    await attachThread("target-instance", "target-session")
    await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
    })

    const endedResult = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentMarkdown: "brief content",
    })
    expect(endedResult).toBeNull()

    const unknownResult = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "never-existed",
      runtimeSessionId: "never-existed",
      contentMarkdown: "brief content",
    })
    expect(unknownResult).toBeNull()

    const invocations = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM bot_invocations WHERE workspace_id = $1",
      [workspace]
    )
    expect(invocations.rows[0]!.count).toBe("0")
  })

  describe("against an end-to-end encrypted root", () => {
    let e2eFixture: BotRuntimeFixture
    let e2ePool: Pool
    let e2eWorkspace: string
    let e2eRoot: string
    let e2eAuthor: string
    let e2eBot: string

    beforeAll(async () => {
      e2eFixture = await seedBotRuntimeFixture({ label: "session_brief_e2e", instanceIds: ["e2e-instance"] })
      ;({ pool: e2ePool, workspace: e2eWorkspace, stream: e2eRoot, author: e2eAuthor, bot: e2eBot } = e2eFixture)
    }, 30_000)

    afterAll(async () => {
      await e2eFixture?.cleanup()
    }, 30_000)

    test("refuses with 400 E2E_STREAM_PLAINTEXT_UNSUPPORTED and writes nothing", async () => {
      const anchor = await MessageRepository.insert(e2ePool, {
        id: messageId(),
        streamId: e2eRoot,
        sequence: 1n,
        authorId: e2eAuthor,
        authorType: "user",
        contentJson: testContentJson("anchor"),
        contentMarkdown: "anchor",
      })
      await new BotRuntimeService({
        pool: e2ePool,
        streamService: new StreamService(e2ePool),
      }).attachRuntimeSessionToThread({
        workspaceId: e2eWorkspace,
        botId: e2eBot,
        ownerUserId: e2eAuthor,
        runtimeKind: "openclaw",
        instanceId: "e2e-instance",
        runtimeSessionId: "e2e-session",
        rootStreamId: e2eRoot,
        anchorId: anchor.id,
        displayName: "Sub work",
        traits: ["active-scratchpad"],
      })
      // Encrypted after the attach: attach refuses an E2E root outright, so this
      // is the sequence that actually reaches the brief with one — a scratchpad
      // the owner turned on encryption for while its thread session was running.
      await E2eStreamsRepository.markStreamE2e(e2ePool, {
        streamId: e2eRoot,
        workspaceId: e2eWorkspace,
        ownerUserId: e2eAuthor,
        ownerUserKeyId: "e2ek_test",
      })

      await expect(
        new BotRuntimeService({ pool: e2ePool, streamService: new StreamService(e2ePool) }).briefRuntimeSession({
          workspaceId: e2eWorkspace,
          botId: e2eBot,
          ownerUserId: e2eAuthor,
          instanceId: "e2e-instance",
          runtimeSessionId: "e2e-session",
          contentMarkdown: "brief content",
        })
      ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" })

      const invocations = await e2ePool.query<{ count: string }>(
        "SELECT count(*)::text FROM bot_invocations WHERE workspace_id = $1",
        [e2eWorkspace]
      )
      expect(invocations.rows[0]!.count).toBe("0")
    })
  })
})
