import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { BotRuntimeService, BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { StreamService } from "../../src/features/streams"
import { MessageRepository } from "../../src/features/messaging"
import { botRuntimeSessionLinkId, messageId, streamId } from "../../src/lib/id"

describe("endRuntimeSession", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  const service = () => new BotRuntimeService({ pool, streamService: new StreamService(pool) })

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "session_end", instanceIds: ["claimed-instance"] })
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
  async function anchorMessage(markdown = "anchor message", targetStreamId = root) {
    sequence += 1n
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: targetStreamId,
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
      runtimeKind: "pi-local",
      instanceId,
      runtimeSessionId,
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })
  }

  test("ends the active link and frees the identity", async () => {
    const desk = await service().createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "pi-local",
      instanceId: "desk-instance",
      runtimeSessionId: "desk-session",
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })

    const { link, stream: thread } = await attachThread("thread-instance", "thread-session")

    const ended = await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "thread-instance",
      runtimeSessionId: "thread-session",
    })
    expect(ended).toMatchObject({ id: link.id, status: "ended", rootStreamId: root, activeStreamId: thread.id })

    const threadLink = await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
      workspaceId: workspace,
      botId: bot,
      rootStreamId: root,
      activeStreamId: thread.id,
    })
    expect(threadLink).toBeNull()

    const rootLink = await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
      workspaceId: workspace,
      botId: bot,
      rootStreamId: root,
      activeStreamId: root,
    })
    expect(rootLink).toMatchObject({ id: desk.id })

    // The retired identity is free: the same (instance, session) pair can link a
    // fresh stream instead of being blocked by the ended row's unique key.
    const anotherThread = await attachThread("other-instance", "other-session")
    const revived = await service().createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "pi-local",
      instanceId: "thread-instance",
      runtimeSessionId: "thread-session",
      rootStreamId: root,
      activeStreamId: anotherThread.stream.id,
      linkedBy: author,
    })
    expect(revived).toMatchObject({
      instanceId: "thread-instance",
      runtimeSessionId: "thread-session",
      status: "active",
    })
  })

  test("allows a fresh attach on the same anchor after the thread's link was ended", async () => {
    const anchor = await anchorMessage()
    const first = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      runtimeKind: "pi-local",
      instanceId: "reuse-instance-1",
      runtimeSessionId: "reuse-session-1",
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })

    await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "reuse-instance-1",
      runtimeSessionId: "reuse-session-1",
    })

    const second = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      runtimeKind: "pi-local",
      instanceId: "reuse-instance-2",
      runtimeSessionId: "reuse-session-2",
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })

    expect(second.stream.id).toBe(first.stream.id)
    expect(second.link).toMatchObject({
      activeStreamId: first.stream.id,
      runtimeSessionId: "reuse-session-2",
      status: "active",
    })
  })

  test("cancels pending invocations targeted at the ended session and leaves other pending rows alone", async () => {
    const link = (instanceId: string, runtimeSessionId: string, activeStreamId: string) =>
      BotRuntimeSessionLinkRepository.upsert(pool, {
        id: botRuntimeSessionLinkId(),
        workspaceId: workspace,
        botId: bot,
        runtimeKind: "openclaw",
        instanceId,
        runtimeSessionId,
        rootStreamId: root,
        activeStreamId,
        linkedBy: author,
      })

    // Distinct activeStreamIds: `upsert`'s conflict target is (workspace, bot,
    // rootStreamId, activeStreamId), so two identities sharing the root as their
    // active stream would collide and overwrite each other's row.
    const rootAnchor = await anchorMessage("root anchor")
    const otherStreamId = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [otherStreamId, workspace, author, root, rootAnchor.id]
    )

    await link("target-instance", "target-session", root)
    const sourceA = await anchorMessage("message A")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: sourceA.id })

    await link("other-instance", "other-session", otherStreamId)
    const sourceB = await anchorMessage("message B", otherStreamId)
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: sourceB.id })

    await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "target-instance",
      runtimeSessionId: "target-session",
    })

    const rows = await pool.query<{
      source_message_id: string
      status: string
      cancellation_reason: string | null
      target_runtime_session_id: string
    }>(
      `SELECT source_message_id, status, cancellation_reason, target_runtime_session_id
       FROM bot_invocations WHERE workspace_id = $1 ORDER BY source_message_id`,
      [workspace]
    )
    const bySource = Object.fromEntries(rows.rows.map((row) => [row.source_message_id, row]))
    expect(bySource).toEqual({
      [sourceA.id]: {
        source_message_id: sourceA.id,
        status: "cancelled",
        cancellation_reason: "routing_changed",
        target_runtime_session_id: "target-session",
      },
      [sourceB.id]: {
        source_message_id: sourceB.id,
        status: "pending",
        cancellation_reason: null,
        target_runtime_session_id: "other-session",
      },
    })
  })

  test("cancels an invocation already claimed by the ended session", async () => {
    await BotRuntimeSessionLinkRepository.upsert(pool, {
      id: botRuntimeSessionLinkId(),
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "openclaw",
      instanceId: "claimed-instance",
      runtimeSessionId: "claimed-session",
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })
    const source = await anchorMessage("mid-turn message")
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })

    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: "claimed-instance",
      runtimeSessionId: "claimed-session",
      runtimeKind: "openclaw",
      claimToken: "claim-token",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).toMatchObject({ status: "claimed", targetRuntimeSessionId: "claimed-session" })

    await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "claimed-instance",
      runtimeSessionId: "claimed-session",
    })

    // The pane is gone, so this turn can never complete, and the claim query's
    // target filter means no other session may take it over. Left claimed it
    // would answer the user's message with nothing, forever.
    const row = await pool.query<{ status: string; cancellation_reason: string | null }>(
      "SELECT status, cancellation_reason FROM bot_invocations WHERE id = $1",
      [claimed?.id]
    )
    expect(row.rows[0]).toEqual({ status: "cancelled", cancellation_reason: "routing_changed" })
  })

  test("route resolution's link read blocks a concurrent end of that link", async () => {
    const link = await BotRuntimeSessionLinkRepository.upsert(pool, {
      id: botRuntimeSessionLinkId(),
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "openclaw",
      instanceId: "locked-instance",
      runtimeSessionId: "locked-session",
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })

    const reader = await pool.connect()
    try {
      await reader.query("BEGIN")
      const read = await BotRuntimeSessionLinkRepository.findActiveByStreamForShare(reader, {
        workspaceId: workspace,
        botId: bot,
        rootStreamId: root,
        activeStreamId: root,
      })
      expect(read).toMatchObject({ id: link.id })

      // `sessions/end` updates this row. NOWAIT turns the wait into an error, so
      // this asserts the share lock is really held rather than timing a sleep.
      await expect(
        pool.query("SELECT id FROM bot_runtime_session_links WHERE id = $1 FOR UPDATE NOWAIT", [link.id])
      ).rejects.toMatchObject({ code: "55P03" })
    } finally {
      await reader.query("ROLLBACK")
      reader.release()
    }

    await expect(
      pool.query("SELECT id FROM bot_runtime_session_links WHERE id = $1 FOR UPDATE NOWAIT", [link.id])
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  test("returns null for an already-ended or unknown identity", async () => {
    await attachThread("once-instance", "once-session")

    const first = await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "once-instance",
      runtimeSessionId: "once-session",
    })
    expect(first).not.toBeNull()

    const second = await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "once-instance",
      runtimeSessionId: "once-session",
    })
    expect(second).toBeNull()

    const unknown = await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "never-existed",
      runtimeSessionId: "never-existed",
    })
    expect(unknown).toBeNull()
  })

  test("an ended link is not revived by reactivateArchivedByRootStream", async () => {
    const { stream: thread } = await attachThread("archive-check-instance", "archive-check-session")
    await service().endRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      instanceId: "archive-check-instance",
      runtimeSessionId: "archive-check-session",
    })

    await BotRuntimeSessionLinkRepository.reactivateArchivedByRootStream(pool, {
      workspaceId: workspace,
      rootStreamId: root,
    })

    const revived = await BotRuntimeSessionLinkRepository.findActiveByStream(pool, {
      workspaceId: workspace,
      botId: bot,
      rootStreamId: root,
      activeStreamId: thread.id,
    })
    expect(revived).toBeNull()
  })
})
