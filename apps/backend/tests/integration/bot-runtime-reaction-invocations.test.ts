import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { BotInvocationCapabilities, type BotInvocationCapability } from "@threahq/types"
import { botRuntimeServiceFor, seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { BotInvocationRepository, BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { MessageRepository } from "../../src/features/messaging"
import { botRuntimeSessionLinkId, messageId, streamId } from "../../src/lib/id"

const { ACTIVE_SCRATCHPAD, REACTION } = BotInvocationCapabilities
const THUMBS_UP = ":+1:"
const HEART = ":heart:"
const REACTING_INSTANCE = "reacting-instance"
const PLAIN_INSTANCE = "plain-instance"
const REACTING_SESSION = "reacting-session"

describe("reaction invocations", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  const service = () => botRuntimeServiceFor(pool)

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({
      label: "reaction_invocations",
      instanceIds: [REACTING_INSTANCE, PLAIN_INSTANCE],
    })
    ;({ pool, workspace, stream: root, author, bot } = fixture)
    await pool.query(
      "UPDATE bot_runtime_instances SET capabilities = '{\"supportsReactions\": true}' WHERE workspace_id = $1 AND instance_id = $2",
      [workspace, REACTING_INSTANCE]
    )
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  beforeEach(async () => {
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM outbox")
    await pool.query("DELETE FROM messages WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1 AND id <> $2", [workspace, root])
  })

  let sequence = 0n
  function insertMessage(params: { streamId?: string; authorType: "bot" | "user"; markdown: string }) {
    sequence += 1n
    return MessageRepository.insert(pool, {
      workspaceId: workspace,
      id: messageId(),
      streamId: params.streamId ?? root,
      sequence,
      authorId: params.authorType === "bot" ? bot : author,
      authorType: params.authorType,
      contentJson: testContentJson(params.markdown),
      contentMarkdown: params.markdown,
    })
  }

  const botMessage = (targetStreamId?: string) =>
    insertMessage({ streamId: targetStreamId, authorType: "bot", markdown: "Shipped the fix" })

  async function createThread() {
    const anchor = await insertMessage({ authorType: "user", markdown: "anchor" })
    const thread = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [thread, workspace, author, root, anchor.id]
    )
    return thread
  }

  function linkSession(instanceId: string, runtimeSessionId: string, activeStreamId = root) {
    return BotRuntimeSessionLinkRepository.upsert(pool, {
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
  }

  function react(message: { id: string }, change: "added" | "removed", emoji = THUMBS_UP, reactorId = author) {
    return service().recordReactionChange({
      workspaceId: workspace,
      messageId: message.id,
      emoji,
      reactorId,
      change,
    })
  }

  function claim(supportedCapabilities: BotInvocationCapability[], runtimeSessionId = REACTING_SESSION) {
    return service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: REACTING_INSTANCE,
      runtimeSessionId,
      runtimeKind: "openclaw",
      claimToken: `claim-${crypto.randomUUID()}`,
      supportedCapabilities,
      claimTtlSeconds: 60,
    })
  }

  const event = (action: "added" | "removed", emoji = THUMBS_UP) => ({
    action,
    emoji,
    reactorId: author,
    reactorName: null,
  })

  async function reactionRows() {
    const result = await pool.query<{
      status: string
      cancellation_reason: string | null
      metadata: unknown
    }>(
      "SELECT status, cancellation_reason, metadata FROM bot_invocations WHERE workspace_id = $1 AND trigger = 'reaction' ORDER BY created_at, id",
      [workspace]
    )
    return result.rows.map((row) => ({
      status: row.status,
      cancellationReason: row.cancellation_reason,
      events: (row.metadata as { reaction: { events: unknown[] } }).reaction.events,
    }))
  }

  async function reactionInvocationIds() {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM bot_invocations WHERE workspace_id = $1 AND trigger = 'reaction' ORDER BY created_at, id",
      [workspace]
    )
    return result.rows.map((row) => row.id)
  }

  async function outboxInvocationIds(eventType: string) {
    const result = await pool.query<{ invocation_id: string }>(
      "SELECT payload ->> 'invocationId' AS invocation_id FROM outbox WHERE event_type = $1",
      [eventType]
    )
    return result.rows.map((row) => row.invocation_id)
  }

  test("should queue one targeted reaction invocation when a human reacts to the bot's message in a linked scratchpad", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()

    await react(message, "added")

    const { rows } = await pool.query(
      `SELECT id, status, required_capability, prompt_markdown, author_user_id, root_stream_id, active_stream_id,
              response_stream_id, source_message_id, target_instance_id, target_runtime_session_id, metadata
       FROM bot_invocations WHERE workspace_id = $1 AND trigger = 'reaction'`,
      [workspace]
    )
    expect(rows).toEqual([
      {
        id: expect.any(String),
        status: "pending",
        required_capability: "reaction",
        prompt_markdown: "Shipped the fix",
        author_user_id: author,
        root_stream_id: root,
        active_stream_id: root,
        response_stream_id: root,
        source_message_id: message.id,
        target_instance_id: REACTING_INSTANCE,
        target_runtime_session_id: REACTING_SESSION,
        metadata: { reaction: { events: [event("added")] } },
      },
    ])
    expect(await outboxInvocationIds("bot_invocation:available")).toEqual([rows[0].id])
  })

  test("should coalesce a second reaction into the same pending invocation without a second nudge", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()

    await react(message, "added", THUMBS_UP)
    await react(message, "added", HEART)

    expect(await reactionRows()).toEqual([
      { status: "pending", cancellationReason: null, events: [event("added", THUMBS_UP), event("added", HEART)] },
    ])
    expect(await outboxInvocationIds("bot_invocation:available")).toEqual(await reactionInvocationIds())
  })

  test("should ignore a repeated add of a reaction the agent already has", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()

    await react(message, "added")
    await react(message, "added")

    expect(await reactionRows()).toEqual([{ status: "pending", cancellationReason: null, events: [event("added")] }])
  })

  test("should cancel the pending invocation when its only reaction is removed before delivery", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()

    await react(message, "added")
    await react(message, "removed")

    expect(await reactionRows()).toEqual([
      { status: "cancelled", cancellationReason: "routing_changed", events: [event("added")] },
    ])
    expect(await outboxInvocationIds("bot_invocation:cancelled")).toEqual(await reactionInvocationIds())
    expect(await claim([REACTION])).toBeNull()
  })

  test("should withdraw only the removed reaction and keep the invocation pending for the rest", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()

    await react(message, "added", THUMBS_UP)
    await react(message, "added", HEART)
    await react(message, "removed", THUMBS_UP)

    expect(await reactionRows()).toEqual([
      { status: "pending", cancellationReason: null, events: [event("added", HEART)] },
    ])
  })

  test("should wake the agent with a removed event once the add has been delivered", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added")
    const claimed = await claim([REACTION])
    expect(claimed).toMatchObject({
      trigger: "reaction",
      sourceMessageId: message.id,
      metadata: { reaction: { events: [event("added")] } },
    })

    await react(message, "removed")

    expect(await reactionRows()).toEqual([
      { status: "claimed", cancellationReason: null, events: [event("added")] },
      { status: "pending", cancellationReason: null, events: [event("removed")] },
    ])
  })

  test("should not wake the agent again for a removal it was already told about, nor for a removal undone before it saw it", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added")
    await claim([REACTION])
    await react(message, "removed")

    await react(message, "removed")
    await react(message, "added")

    expect(await reactionRows()).toEqual([
      { status: "claimed", cancellationReason: null, events: [event("added")] },
      { status: "cancelled", cancellationReason: "routing_changed", events: [event("removed")] },
    ])
  })

  test("should wake the session the scratchpad is linked to now, not the one it was linked to when the reaction queued", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added", THUMBS_UP)

    await linkSession(REACTING_INSTANCE, "relinked-session")
    await react(message, "added", HEART)

    expect(await claim([REACTION], REACTING_SESSION)).toBeNull()
    expect(await claim([REACTION], "relinked-session")).toMatchObject({
      trigger: "reaction",
      metadata: { reaction: { events: [event("added", THUMBS_UP), event("added", HEART)] } },
    })
  })

  test("should retarget a pending invocation to the stream's new session when a reaction is withdrawn from it", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added", THUMBS_UP)
    await react(message, "added", HEART)

    await linkSession(REACTING_INSTANCE, "relinked-session")
    await react(message, "removed", THUMBS_UP)

    expect(await claim([REACTION], "relinked-session")).toMatchObject({
      metadata: { reaction: { events: [event("added", HEART)] } },
    })
  })

  test.each(["cancelled", "parked"] as const)(
    "should still wake the agent for a removal when the turn that delivered the add ended %s",
    async (outcome) => {
      await linkSession(REACTING_INSTANCE, REACTING_SESSION)
      const message = await botMessage()
      await react(message, "added")
      const claimed = await claim([REACTION])
      if (outcome === "cancelled") {
        await BotInvocationRepository.cancelClaim(pool, {
          workspaceId: workspace,
          invocationId: claimed!.id,
          reason: "input_stale",
        })
      } else {
        await pool.query("UPDATE bot_invocations SET status = 'parked' WHERE id = $1", [claimed!.id])
      }

      await react(message, "removed")

      expect(await reactionRows()).toEqual([
        {
          status: outcome,
          cancellationReason: outcome === "cancelled" ? "input_stale" : null,
          events: [event("added")],
        },
        { status: "pending", cancellationReason: null, events: [event("removed")] },
      ])
    }
  )

  test("should do nothing when a reaction the agent never heard of is removed", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()

    await react(message, "removed")

    expect(await reactionRows()).toEqual([])
  })

  test("should not wake the agent for a reaction on another author's message", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await insertMessage({ authorType: "user", markdown: "my own note" })

    await react(message, "added")

    expect(await reactionRows()).toEqual([])
  })

  test("should not queue anything when the linked runtime does not advertise reaction support", async () => {
    await linkSession(PLAIN_INSTANCE, "plain-session")
    const message = await botMessage()

    await react(message, "added")

    expect(await reactionRows()).toEqual([])
  })

  test("should not queue anything when no runtime session is linked to the stream", async () => {
    const message = await botMessage()

    await react(message, "added")

    expect(await reactionRows()).toEqual([])
  })

  test("should hand the reaction invocation only to a claim that asks for the reaction capability", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added")

    expect(await claim([ACTIVE_SCRATCHPAD])).toBeNull()
    expect(await claim([REACTION])).toMatchObject({ trigger: "reaction", sourceMessageId: message.id })
  })

  test("should not hand the invocation to a session other than the linked one", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added")

    expect(await claim([REACTION], "someone-else")).toBeNull()
  })

  test("should cover a thread under the linked scratchpad", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const thread = await createThread()
    const message = await botMessage(thread)

    await react(message, "added")

    const { rows } = await pool.query(
      "SELECT root_stream_id, active_stream_id, response_stream_id, target_runtime_session_id FROM bot_invocations WHERE trigger = 'reaction' AND workspace_id = $1",
      [workspace]
    )
    expect(rows).toEqual([
      {
        root_stream_id: root,
        active_stream_id: thread,
        response_stream_id: thread,
        target_runtime_session_id: REACTING_SESSION,
      },
    ])
    expect(await claim([REACTION])).toMatchObject({ trigger: "reaction", activeStreamId: thread })
  })

  test("should prefer the session linked to the thread itself over the scratchpad's session", async () => {
    await linkSession(PLAIN_INSTANCE, "desk-session")
    const thread = await createThread()
    await linkSession(REACTING_INSTANCE, REACTING_SESSION, thread)
    const message = await botMessage(thread)

    await react(message, "added")

    const { rows } = await pool.query(
      "SELECT target_instance_id, target_runtime_session_id FROM bot_invocations WHERE trigger = 'reaction' AND workspace_id = $1",
      [workspace]
    )
    expect(rows).toEqual([{ target_instance_id: REACTING_INSTANCE, target_runtime_session_id: REACTING_SESSION }])
  })

  test("should not treat a completed reaction turn as having answered a brief on the same message", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added")
    await claim([REACTION])
    await pool.query(
      "UPDATE bot_invocations SET status = 'completed', completed_at = NOW() WHERE workspace_id = $1 AND trigger = 'reaction'",
      [workspace]
    )

    const briefed = await service().briefRuntimeSession({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      instanceId: REACTING_INSTANCE,
      runtimeSessionId: REACTING_SESSION,
      contentMarkdown: "Follow up on the fix",
      thread: { anchorId: message.id, displayName: "Follow-up" },
    })

    expect(briefed?.invocation).toMatchObject({
      trigger: "brief",
      sourceMessageId: message.id,
      promptMarkdown: "Follow up on the fix",
      status: "pending",
    })
  })

  test("should survive route reconciliation of the bot's message but not its deletion", async () => {
    await linkSession(REACTING_INSTANCE, REACTING_SESSION)
    const message = await botMessage()
    await react(message, "added")

    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    expect(await reactionRows()).toEqual([{ status: "pending", cancellationReason: null, events: [event("added")] }])

    await pool.query("UPDATE messages SET deleted_at = NOW(), revision = revision + 1 WHERE id = $1", [message.id])
    await service().cancelInvocationsForDeletedSource({ workspaceId: workspace, sourceMessageId: message.id })
    expect(await reactionRows()).toEqual([
      { status: "cancelled", cancellationReason: "source_deleted", events: [event("added")] },
    ])
  })
})
