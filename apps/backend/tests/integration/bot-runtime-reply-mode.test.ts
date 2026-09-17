import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { CommandAvailabilityService, CommandRegistry, RepliesCommand, ThreadCommand } from "../../src/features/commands"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { BotRepository } from "../../src/features/public-api"
import { MESSAGE_METADATA_REPLY_IN_THREAD_KEY, MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { botChannelAccessId, commandId, messageId, streamId, workspaceId } from "../../src/lib/id"
import { addTestMember, botRuntimeServiceFor, setupIsolatedTestDatabase, testContentJson } from "./setup"

describe("linked session reply mode", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let sequence = 0n

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("reply_mode")
    pool = isolated.pool
    cleanup = isolated.cleanup
  }, 30_000)

  afterAll(async () => {
    await cleanup?.()
  }, 30_000)

  async function seed() {
    const workspace = workspaceId()
    const root = streamId()
    const owner = (await addTestMember(pool, workspace, `workos-${crypto.randomUUID()}`)).id
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [root, workspace, owner]
    )
    await StreamMemberRepository.insert(pool, root, owner)
    const bot = `bot_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
    await BotRepository.create(pool, {
      id: bot,
      workspaceId: workspace,
      type: "personal",
      ownerUserId: owner,
      traits: ["active-scratchpad", "mentionable"],
      slug: `homer-${crypto.randomUUID().slice(0, 8)}`,
      name: "Homer",
    })
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: workspace,
      botId: bot,
      streamId: root,
      grantedBy: owner,
    })
    const instance = `instance-${crypto.randomUUID()}`
    const session = `session-${crypto.randomUUID()}`
    const link = await botRuntimeServiceFor(pool).createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "hermes",
      instanceId: instance,
      runtimeSessionId: session,
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: owner,
    })
    return { workspace, root, owner, bot, instance, session, link }
  }

  async function post(stream: string, author: string, markdown: string, metadata?: Record<string, string>) {
    sequence += 1n
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: stream,
      sequence,
      authorId: author,
      authorType: "user",
      contentJson: testContentJson(markdown),
      contentMarkdown: markdown,
      metadata,
    })
  }

  async function replies(scenario: Awaited<ReturnType<typeof seed>>, args: string) {
    return new RepliesCommand({ pool }).execute({
      commandId: commandId(),
      commandName: "replies",
      workspaceId: scenario.workspace,
      streamId: scenario.root,
      userId: scenario.owner,
      args,
    })
  }

  async function invocationsFor(sourceMessageId: string) {
    const result = await pool.query<{ response_stream_id: string; status: string }>(
      "SELECT response_stream_id, status FROM bot_invocations WHERE source_message_id = $1 ORDER BY created_at",
      [sourceMessageId]
    )
    return result.rows
  }

  test("should report flat by default and persist a switch to thread across a relink", async () => {
    const scenario = await seed()

    expect(await replies(scenario, "")).toEqual({ success: true, result: { replyMode: "flat" } })
    expect(await replies(scenario, "Thread")).toEqual({ success: true, result: { replyMode: "thread" } })
    expect(await replies(scenario, "sideways")).toEqual({ success: false, error: "Usage: /replies [thread|flat]" })

    const relinked = await botRuntimeServiceFor(pool).createOrLinkPiRemoteSession({
      workspaceId: scenario.workspace,
      botId: scenario.bot,
      runtimeKind: "hermes",
      instanceId: scenario.instance,
      runtimeSessionId: `session-${crypto.randomUUID()}`,
      rootStreamId: scenario.root,
      activeStreamId: scenario.root,
      linkedBy: scenario.owner,
    })
    expect({ id: relinked.id, replyMode: relinked.replyMode }).toEqual({
      id: scenario.link.id,
      replyMode: "thread",
    })
  })

  test("should offer /replies only in a scratchpad with a linked session", async () => {
    const scenario = await seed()
    const registry = new CommandRegistry()
    registry.register(new RepliesCommand({ pool }))
    const availability = new CommandAvailabilityService({ pool, commandRegistry: registry })
    const resolve = () =>
      availability.resolveCommand({
        workspaceId: scenario.workspace,
        userId: scenario.owner,
        streamId: scenario.root,
        name: "replies",
      })

    expect((await resolve())?.info).toMatchObject({ name: "replies", args: [{ name: "mode" }] })

    await BotRuntimeSessionLinkRepository.setReplyMode(pool, {
      workspaceId: scenario.workspace,
      linkId: scenario.link.id,
      replyMode: "thread",
    })
    await pool.query("UPDATE bot_runtime_session_links SET status = 'ended' WHERE id = $1", [scenario.link.id])
    expect(await resolve()).toBeNull()
  })

  test("should answer a root message in a thread anchored on it that the claim still matches", async () => {
    const scenario = await seed()
    await replies(scenario, "thread")
    const service = botRuntimeServiceFor(pool)

    const message = await post(scenario.root, scenario.owner, "what changed?")
    await service.reconcileInvocationSource({ workspaceId: scenario.workspace, sourceMessageId: message.id })
    const thread = await StreamRepository.findByAnchor(pool, scenario.root, message.id)
    expect(thread).toMatchObject({ type: "thread", rootStreamId: scenario.root, createdBy: scenario.bot })

    // An edit reconciles again: it must find the same thread, not supersede the invocation.
    await service.reconcileInvocationSource({ workspaceId: scenario.workspace, sourceMessageId: message.id })
    expect(await invocationsFor(message.id)).toEqual([{ response_stream_id: thread!.id, status: "pending" }])

    const claimed = await service.claimNextInvocation({
      workspaceId: scenario.workspace,
      botId: scenario.bot,
      instanceId: scenario.instance,
      runtimeSessionId: scenario.session,
      runtimeKind: "hermes",
      claimToken: "reply-thread",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).toMatchObject({ sourceMessageId: message.id, responseStreamId: thread!.id, status: "claimed" })

    const inThread = await post(thread!.id, scenario.owner, "follow-up")
    await service.reconcileInvocationSource({ workspaceId: scenario.workspace, sourceMessageId: inThread.id })
    expect(await invocationsFor(inThread.id)).toEqual([{ response_stream_id: thread!.id, status: "pending" }])
  })

  test("should offer /thread only in an unsealed scratchpad with a linked session", async () => {
    const scenario = await seed()
    const registry = new CommandRegistry()
    registry.register(new ThreadCommand())
    const availability = new CommandAvailabilityService({ pool, commandRegistry: registry })
    const resolve = () =>
      availability.resolveCommand({
        workspaceId: scenario.workspace,
        userId: scenario.owner,
        streamId: scenario.root,
        name: "thread",
      })

    expect((await resolve())?.info).toMatchObject({ name: "thread", args: [{ name: "message", required: true }] })

    await E2eStreamsRepository.markStreamE2e(pool, {
      streamId: scenario.root,
      workspaceId: scenario.workspace,
      ownerUserId: scenario.owner,
      ownerUserKeyId: "e2ek_owner",
    })
    expect(await resolve()).toBeNull()
  })

  test("should answer a /thread message in a thread on it when the session replies flat", async () => {
    const scenario = await seed()
    const service = botRuntimeServiceFor(pool)
    const message = await post(scenario.root, scenario.owner, "just this once", {
      [MESSAGE_METADATA_REPLY_IN_THREAD_KEY]: "true",
    })
    await service.reconcileInvocationSource({ workspaceId: scenario.workspace, sourceMessageId: message.id })

    const thread = await StreamRepository.findByAnchor(pool, scenario.root, message.id)
    expect(thread).toMatchObject({ type: "thread", rootStreamId: scenario.root, createdBy: scenario.bot })
    expect(await invocationsFor(message.id)).toEqual([{ response_stream_id: thread!.id, status: "pending" }])

    const claimed = await service.claimNextInvocation({
      workspaceId: scenario.workspace,
      botId: scenario.bot,
      instanceId: scenario.instance,
      runtimeSessionId: scenario.session,
      runtimeKind: "hermes",
      claimToken: "thread-once",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    expect(claimed).toMatchObject({ sourceMessageId: message.id, responseStreamId: thread!.id, status: "claimed" })
  })

  test("should answer a root message in the scratchpad in flat mode", async () => {
    const scenario = await seed()
    const message = await post(scenario.root, scenario.owner, "flat please")
    await botRuntimeServiceFor(pool).reconcileInvocationSource({
      workspaceId: scenario.workspace,
      sourceMessageId: message.id,
    })

    expect({
      thread: await StreamRepository.findByAnchor(pool, scenario.root, message.id),
      invocations: await invocationsFor(message.id),
    }).toEqual({ thread: null, invocations: [{ response_stream_id: scenario.root, status: "pending" }] })
  })
})
