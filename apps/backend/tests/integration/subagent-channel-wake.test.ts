/**
 * The user's reply reaches a subagent that lives in a CHANNEL.
 *
 * A channel has no companion mode, so a thread hanging off one would never
 * re-dispatch on the ordinary rules — the delegated model would ask a question
 * and never hear the answer. `CompanionHandler` therefore resolves an active
 * `subagent_runs` row first and dispatches THAT run's persona. Everything else
 * about the handler is unchanged: a settled run reverts the thread to the normal
 * rules, and the running-session suppression still applies.
 *
 * Driven through the handler's own `processEvent` against a real database
 * (INV-68) — real streams, personas, runs and sessions; only the queue is a
 * spy, because the dispatch IS the observable behavior.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import type { Pool } from "pg"
import { AuthorTypes } from "@threahq/types"
import { CompanionHandler } from "../../src/features/agents/companion-outbox-handler"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { SubagentService } from "../../src/features/subagents"
import { JobQueues, type QueueManager } from "../../src/lib/queue"
import { messageId, sessionId } from "../../src/lib/id"
import type { OutboxEvent } from "../../src/lib/outbox"
import { setupIsolatedTestDatabase, testMessageContent, withTransaction } from "./setup"
import { MessageRepository } from "../../src/features/messaging"
import { createParams, createSubagentTestContext, type SubagentTestContext } from "./subagent-support"

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService

/** `processEvent` is the handler's unit of work; the cursor/debounce shell above it is not under test. */
class TestCompanionHandler extends CompanionHandler {
  process(event: OutboxEvent): Promise<void> {
    return this.processEvent(event)
  }
}

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-wake")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "wake")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
})

afterAll(async () => {
  await cleanup()
})

function userMessageEvent(streamId: string): OutboxEvent {
  return {
    id: 1n,
    eventType: "message:created",
    payload: {
      workspaceId: ctx.workspaceId,
      streamId,
      event: {
        actorId: ctx.member,
        actorType: AuthorTypes.USER,
        sequence: "5",
        payload: { messageId: messageId() },
      },
    },
    createdAt: new Date(),
  } as unknown as OutboxEvent
}

function createHandler() {
  const send = mock(async () => "queue_1")
  const handler = new TestCompanionHandler(pool, { send } as unknown as QueueManager)
  return { handler, send }
}

async function subagentThreadInChannel(slug: string) {
  const channel = await ctx.createChannel({ slug, memberIds: [ctx.owner, ctx.member] })
  const created = await subagentService.create(createParams(ctx, channel.id))
  return { channel, ...created }
}

describe("subagent thread in a channel", () => {
  test("a user reply dispatches the run's persona even though the channel has no companion mode", async () => {
    const { threadStreamId } = await subagentThreadInChannel("wake-active")
    const { handler, send } = createHandler()

    const event = userMessageEvent(threadStreamId)
    await handler.process(event)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(JobQueues.PERSONA_AGENT, {
      workspaceId: ctx.workspaceId,
      streamId: threadStreamId,
      messageId: (event.payload as { event: { payload: { messageId: string } } }).event.payload.messageId,
      personaId: ctx.persona.id,
      triggeredBy: ctx.member,
    })
  })

  test("a settled run reverts the thread to the ordinary rules — no dispatch", async () => {
    const { run, threadStreamId } = await subagentThreadInChannel("wake-settled")
    await subagentService.reportBack({
      workspaceId: ctx.workspaceId,
      id: run.id,
      resultMessageId: messageId(),
    })
    const { handler, send } = createHandler()

    await handler.process(userMessageEvent(threadStreamId))

    expect(send).not.toHaveBeenCalled()
  })

  test("a channel thread that never hosted a subagent does not dispatch", async () => {
    const channel = await ctx.createChannel({ slug: "wake-plain", memberIds: [ctx.owner, ctx.member] })
    const anchorId = messageId()
    await withTransaction(pool, async (client) => {
      await MessageRepository.insert(client, {
        id: anchorId,
        streamId: channel.id,
        sequence: 1,
        authorId: ctx.member,
        authorType: AuthorTypes.USER,
        ...testMessageContent("plain thread anchor"),
      })
    })
    const thread = await ctx.streamService.createThreadInternal({
      workspaceId: ctx.workspaceId,
      parentStreamId: channel.id,
      parentAnchorId: anchorId,
      createdBy: ctx.member,
    })
    const { handler, send } = createHandler()

    await handler.process(userMessageEvent(thread.id))

    expect(send).not.toHaveBeenCalled()
  })

  test("a cancelled run reverts the thread to the ordinary rules — no dispatch", async () => {
    const channel = await ctx.createChannel({ slug: "wake-baseline", memberIds: [ctx.owner] })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))
    await subagentService.cancel({
      workspaceId: ctx.workspaceId,
      id: run.id,
      parentStreamId: channel.id,
      cancelledBy: { actorId: ctx.owner, actorType: AuthorTypes.USER },
    })
    const { handler, send } = createHandler()

    await handler.process(userMessageEvent(threadStreamId))

    expect(send).not.toHaveBeenCalled()
  })

  test("a session already running in the thread still suppresses the dispatch", async () => {
    const { threadStreamId } = await subagentThreadInChannel("wake-running")
    await AgentSessionRepository.insert(pool, {
      id: sessionId(),
      streamId: threadStreamId,
      personaId: ctx.persona.id,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
    })
    const { handler, send } = createHandler()

    await handler.process(userMessageEvent(threadStreamId))

    expect(send).not.toHaveBeenCalled()
  })
})
