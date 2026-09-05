import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { BotRuntimeService } from "../../src/features/bot-runtimes"
import { StreamService } from "../../src/features/streams"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { messageId } from "../../src/lib/id"

describe("briefRuntimeSession", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  const service = () =>
    new BotRuntimeService({ pool, streamService: new StreamService(pool), eventService: new EventService(pool) })

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
    return service().attachRuntimeSessionToThread({
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
  }

  test("briefs the thread session with a bot-authored message and a targeted invocation", async () => {
    const { link, stream: thread } = await attachThread("target-instance", "target-session")

    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentJson: testContentJson("brief content"),
      contentMarkdown: "brief content",
    })

    expect(briefed).not.toBeNull()
    expect(briefed!.message).toMatchObject({
      streamId: thread.id,
      authorId: bot,
      authorType: "bot",
      contentMarkdown: "brief content",
    })
    expect(briefed!.invocation).toMatchObject({
      workspaceId: workspace,
      rootStreamId: root,
      activeStreamId: thread.id,
      sourceMessageId: briefed!.message.id,
      responseStreamId: thread.id,
      actorType: "bot",
      actorId: bot,
      trigger: "brief",
      requiredCapability: "active-scratchpad",
      status: "pending",
      authorUserId: author,
      targetInstanceId: link.instanceId,
      targetRuntimeSessionId: link.runtimeSessionId,
    })
  })

  test("the briefed invocation is claimable only by the targeted identity", async () => {
    await attachThread("target-instance", "target-session")
    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentJson: testContentJson("brief content"),
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

  test("the outbox route reconcile leaves the brief invocation pending", async () => {
    await attachThread("target-instance", "target-session")
    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentJson: testContentJson("brief content"),
      contentMarkdown: "brief content",
    })
    expect(briefed).not.toBeNull()

    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: briefed!.message.id })

    const row = await pool.query<{ status: string; cancellation_reason: string | null }>(
      "SELECT status, cancellation_reason FROM bot_invocations WHERE workspace_id = $1 AND id = $2",
      [workspace, briefed!.invocation.id]
    )
    expect(row.rows[0]).toEqual({ status: "pending", cancellation_reason: null })
  })

  test("returns null and writes no message for an ended or unknown identity", async () => {
    await attachThread("target-instance", "target-session")
    await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
    })

    const beforeCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM messages WHERE stream_id != $1",
      [root]
    )

    const endedResult = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
      contentJson: testContentJson("brief content"),
      contentMarkdown: "brief content",
    })
    expect(endedResult).toBeNull()

    const unknownResult = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: "never-existed",
      runtimeSessionId: "never-existed",
      contentJson: testContentJson("brief content"),
      contentMarkdown: "brief content",
    })
    expect(unknownResult).toBeNull()

    const afterCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM messages WHERE stream_id != $1",
      [root]
    )
    expect(afterCount.rows[0]!.count).toBe(beforeCount.rows[0]!.count)
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
      await E2eStreamsRepository.markStreamE2e(e2ePool, {
        streamId: e2eRoot,
        workspaceId: e2eWorkspace,
        ownerUserId: e2eAuthor,
        ownerUserKeyId: "e2ek_test",
      })
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
      const { stream: thread } = await new BotRuntimeService({
        pool: e2ePool,
        streamService: new StreamService(e2ePool),
        eventService: new EventService(e2ePool),
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

      const beforeCount = await e2ePool.query<{ count: string }>(
        "SELECT count(*)::text FROM messages WHERE stream_id = $1",
        [thread.id]
      )

      await expect(
        new BotRuntimeService({
          pool: e2ePool,
          streamService: new StreamService(e2ePool),
          eventService: new EventService(e2ePool),
        }).briefRuntimeSession({
          workspaceId: e2eWorkspace,
          botId: e2eBot,
          ownerUserId: e2eAuthor,
          instanceId: "e2e-instance",
          runtimeSessionId: "e2e-session",
          contentJson: testContentJson("brief content"),
          contentMarkdown: "brief content",
        })
      ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" })

      const afterCount = await e2ePool.query<{ count: string }>(
        "SELECT count(*)::text FROM messages WHERE stream_id = $1",
        [thread.id]
      )
      expect(afterCount.rows[0]!.count).toBe(beforeCount.rows[0]!.count)
    })
  })
})
