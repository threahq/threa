import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  BotInvocationCapabilities,
  CommandKinds,
  MessageErrorCodes,
  type BotInvocationCapability,
  type JSONContent,
} from "@threahq/types"
import {
  botRuntimeServiceFor,
  seedBotRuntimeFixture,
  testContentJson,
  withTransaction,
  type BotRuntimeFixture,
} from "./setup"
import { BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { EnqueuedMessageService, MessageRepository } from "../../src/features/messaging"
import { messageId, streamId } from "../../src/lib/id"

const { QUEUED_MESSAGE, ACTIVE_SCRATCHPAD, MENTIONABLE } = BotInvocationCapabilities

describe("enqueued messages", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  let otherStream: string
  const service = () => botRuntimeServiceFor(pool)

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "enqueue", instanceIds: [] })
    ;({ pool, workspace, stream: root, author, bot } = fixture)
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
    const anchor = await message("anchor")
    otherStream = streamId()
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [otherStream, workspace, author, root, anchor.id]
    )
  })

  let sequence = 0n
  async function message(
    markdown: string,
    targetStreamId = root,
    contentJson: JSONContent = testContentJson(markdown)
  ) {
    sequence += 1n
    return MessageRepository.insert(pool, {
      workspaceId: workspace,
      id: messageId(),
      streamId: targetStreamId,
      sequence,
      authorId: author,
      authorType: "user",
      contentJson,
      contentMarkdown: markdown,
    })
  }

  function mentioning(actorId: string, text: string): JSONContent {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: actorId, slug: "someone" } },
            { type: "text", text: ` ${text}` },
          ],
        },
      ],
    }
  }

  function link(instanceId: string, runtimeSessionId: string, activeStreamId = root) {
    return service().createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "pi-local",
      instanceId,
      runtimeSessionId,
      rootStreamId: root,
      activeStreamId,
      linkedBy: author,
    })
  }

  function claim(instanceId: string, runtimeSessionId: string, supportedCapabilities: BotInvocationCapability[]) {
    return service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId,
      runtimeSessionId,
      runtimeKind: "pi-local",
      claimToken: `claim-${crypto.randomUUID()}`,
      supportedCapabilities,
      claimTtlSeconds: 60,
    })
  }

  // Availability (the runtime advertising `enqueue`) is CommandAvailabilityService's
  // contract; these cases are about what gets queued once it resolves the bot.
  async function enqueue(source: { id: string }) {
    const enqueued = new EnqueuedMessageService({
      commandAvailabilityService: {
        resolveCommandInTransaction: async () => ({ executionKind: CommandKinds.BOT_RUNTIME, runtime: { botId: bot } }),
      } as never,
      botRuntimeService: service(),
    })
    const stored = await MessageRepository.findById(pool, workspace, source.id)
    await withTransaction(pool, (db) =>
      enqueued.enqueueInTransaction(db, { workspaceId: workspace, streamId: root, userId: author, message: stored! })
    )
  }

  const rowsFor = (sourceMessageId: string) =>
    pool
      .query<{
        required_capability: string
        trigger: string
        status: string
        response_stream_id: string
      }>(
        "SELECT required_capability, trigger, status, response_stream_id FROM bot_invocations WHERE source_message_id = $1",
        [sourceMessageId]
      )
      .then((result) => result.rows)

  /** Runs the outbox reconcile for the message, then a busy and an idle claim. */
  async function deliver(source: { id: string }, instanceId: string, runtimeSessionId: string) {
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })
    const afterReconcile = await rowsFor(source.id)
    const busyClaim = await claim(instanceId, runtimeSessionId, [ACTIVE_SCRATCHPAD, MENTIONABLE])
    const idleClaim = await claim(instanceId, runtimeSessionId, [QUEUED_MESSAGE])
    return { afterReconcile, busyClaim, idleClaim: idleClaim?.sourceMessageId ?? null }
  }

  test("an enqueued message is one queued-message invocation that only a runtime asking for that capability claims", async () => {
    await link("enq-instance", "enq-session")
    const source = await message("later please")
    await enqueue(source)

    expect(await deliver(source, "enq-instance", "enq-session")).toEqual({
      afterReconcile: [
        {
          required_capability: QUEUED_MESSAGE,
          trigger: "active-scratchpad",
          status: "pending",
          response_stream_id: root,
        },
      ],
      busyClaim: null,
      idleClaim: source.id,
    })
  })

  test("mentioning the linked bot queues the mention route, which reconcile and claim keep", async () => {
    await link("enq-instance", "enq-session")
    const source = await message("@bot later", root, mentioning(bot, "later"))
    await enqueue(source)

    expect(await deliver(source, "enq-instance", "enq-session")).toEqual({
      afterReconcile: [
        { required_capability: QUEUED_MESSAGE, trigger: "mention", status: "pending", response_stream_id: root },
      ],
      busyClaim: null,
      idleClaim: source.id,
    })
  })

  test("in thread reply mode the queued row answers in the reply thread the claim re-resolves", async () => {
    const linked = await link("enq-instance", "enq-session")
    await BotRuntimeSessionLinkRepository.setReplyMode(pool, {
      workspaceId: workspace,
      linkId: linked.id,
      replyMode: "thread",
    })
    const source = await message("later in a thread")
    await enqueue(source)
    const thread = await pool.query<{ id: string }>("SELECT id FROM streams WHERE parent_anchor_id = $1", [source.id])

    expect(await deliver(source, "enq-instance", "enq-session")).toEqual({
      afterReconcile: [
        {
          required_capability: QUEUED_MESSAGE,
          trigger: "active-scratchpad",
          status: "pending",
          response_stream_id: thread.rows[0]?.id,
        },
      ],
      busyClaim: null,
      idleClaim: source.id,
    })
  })

  test("a message the router sends elsewhere is refused instead of queued and later dropped", async () => {
    await link("enq-instance", "enq-session")
    const source = await message("@persona later", root, mentioning("persona_elsewhere", "later"))

    await expect(enqueue(source)).rejects.toMatchObject({ status: 409, code: MessageErrorCodes.ENQUEUE_UNAVAILABLE })
    expect(await rowsFor(source.id)).toEqual([])
  })

  test("a session moving to another instance keeps its queue, threads included, by relink or by rebind", async () => {
    await link("first-instance", "kept-session")
    const relinked = await message("queued before relink")
    await enqueue(relinked)
    const inThread = await message("queued in a thread", otherStream)
    await enqueue(inThread)
    const moved = await link("second-instance", "kept-session")
    const rebound = await message("queued before rebind")
    await enqueue(rebound)

    await service().rebindPiRemoteSessionInstance({
      workspaceId: workspace,
      botId: bot,
      linkId: moved.id,
      instanceId: "second-instance",
      runtimeSessionId: "kept-session",
      newInstanceId: "third-instance",
    })
    const claimed = []
    for (let i = 0; i < 3; i++)
      claimed.push((await claim("third-instance", "kept-session", [QUEUED_MESSAGE]))?.sourceMessageId)

    expect(claimed.sort()).toEqual([relinked.id, inThread.id, rebound.id].sort())
  })
})
