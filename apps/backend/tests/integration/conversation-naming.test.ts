import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { withTransaction } from "../../src/db"
import { ConversationRepository } from "../../src/features/conversations"
import {
  DynamicNamingConversationTarget,
  DynamicNamingService,
  type DynamicNamingDecision,
  type DynamicNamingEvaluationInput,
} from "../../src/features/dynamic-naming"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { MessageFormatter } from "../../src/lib/ai/message-formatter"
import { conversationId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase, testMessageContent } from "./setup"

interface Fixture {
  workspaceId: string
  userId: string
  streamId: string
  conversationId: string
}

describe("dynamic conversation naming", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function fixture(params: {
    count: number
    title?: string
    streamType?: "channel" | "scratchpad"
  }): Promise<Fixture> {
    const ws = workspaceId()
    const user = userId()
    const stream = streamId()
    const conversation = conversationId()
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: stream,
        workspaceId: ws,
        type: params.streamType ?? "channel",
        slug: params.streamType === "scratchpad" ? undefined : `channel-${stream}`,
        visibility: "private",
        companionMode: "off",
        createdBy: user,
      })
      await ConversationRepository.insert(client, {
        id: conversation,
        streamId: stream,
        workspaceId: ws,
        topicSummary: params.title,
        topicSummarySource: params.title ? "generated" : undefined,
      })
      for (let sequence = 1; sequence <= params.count; sequence += 1) {
        const id = messageId()
        await MessageRepository.insert(client, {
          id,
          streamId: stream,
          sequence: BigInt(sequence),
          authorId: user,
          authorType: "user",
          ...testMessageContent(`Message ${sequence} about deployment rollback`),
        })
        await ConversationRepository.addPrimaryMessage(client, ws, conversation, id, user)
      }
    })
    return { workspaceId: ws, userId: user, streamId: stream, conversationId: conversation }
  }

  function service(decide: (input: DynamicNamingEvaluationInput) => Promise<DynamicNamingDecision>) {
    return new DynamicNamingService(
      pool,
      new Map([["conversation", new DynamicNamingConversationTarget(pool, new MessageFormatter())]]),
      { decide },
      { schedule: async () => {} },
      () => new Date(Date.now() + 10_000)
    )
  }

  test("classifier title starts refinement at checkpoint 3", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue" })
    let checkpoint: number | null = null
    const naming = service(async (input) => {
      checkpoint = input.checkpoint
      expect(input.currentTitle).toBe("Deployment issue")
      return { action: "rename", title: "Deployment rollback" }
    })
    expect(
      await naming.evaluate(
        { workspaceId: item.workspaceId, targetKind: "conversation", targetId: item.conversationId },
        "job_refine"
      )
    ).toMatchObject({ status: "evaluated", action: "rename" })
    expect(checkpoint).toBe(3)
    expect(await ConversationRepository.findById(pool, item.conversationId)).toMatchObject({
      topicSummary: "Deployment rollback",
      topicSummarySource: "generated",
      topicSummaryRevision: 2,
    })
  })

  test("an untitled deterministic conversation evaluates checkpoint 1", async () => {
    const item = await fixture({ count: 1 })
    let checkpoint: number | null = null
    const naming = service(async (input) => {
      checkpoint = input.checkpoint
      return { action: "rename", title: "Deployment rollback" }
    })
    await naming.evaluate(
      { workspaceId: item.workspaceId, targetKind: "conversation", targetId: item.conversationId },
      "job_opening"
    )
    expect(checkpoint).toBe(1)
  })

  test("scratchpad conversations make no provider call", async () => {
    const item = await fixture({ count: 3, streamType: "scratchpad" })
    let calls = 0
    const naming = service(async () => {
      calls += 1
      return { action: "rename", title: "Forbidden shadow title" }
    })
    expect(
      await naming.evaluate(
        { workspaceId: item.workspaceId, targetKind: "conversation", targetId: item.conversationId },
        "job_scratchpad"
      )
    ).toEqual({ status: "protected" })
    expect(calls).toBe(0)
  })

  test("a structural outbox retry still schedules after the first queue send fails", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue" })
    let attempts = 0
    const naming = new DynamicNamingService(
      pool,
      new Map([["conversation", new DynamicNamingConversationTarget(pool, new MessageFormatter())]]),
      { decide: async () => ({ action: "keep" }) },
      {
        schedule: async () => {
          attempts += 1
          if (attempts === 1) throw new Error("queue unavailable")
        },
      }
    )
    const ref = {
      workspaceId: item.workspaceId,
      targetKind: "conversation" as const,
      targetId: item.conversationId,
    }
    await expect(naming.recordStructuralEvent(ref, "9050")).rejects.toThrow("queue unavailable")
    await expect(naming.recordStructuralEvent(ref, "9050")).resolves.toBe(true)
    expect(attempts).toBe(2)
  })

  test("a structural reassignment evaluates once after ordinary settlement", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue" })
    const checkpoints: Array<{ checkpoint: number; forced: boolean }> = []
    const naming = service(async (input) => {
      checkpoints.push({ checkpoint: input.checkpoint, forced: input.forced })
      return { action: "keep" }
    })
    const ref = { workspaceId: item.workspaceId, targetKind: "conversation" as const, targetId: item.conversationId }
    await naming.evaluate(ref, "job_cp3")
    await withTransaction(pool, async (client) => {
      for (let sequence = 4; sequence <= 6; sequence += 1) {
        const id = messageId()
        await MessageRepository.insert(client, {
          id,
          streamId: item.streamId,
          sequence: BigInt(sequence),
          authorId: item.userId,
          authorType: "user",
          ...testMessageContent(`Rollback detail ${sequence}`),
        })
        await ConversationRepository.addPrimaryMessage(client, item.workspaceId, item.conversationId, id, item.userId)
      }
    })
    await naming.evaluate(ref, "job_cp6")
    expect(await naming.recordStructuralEvent(ref, "9001")).toBe(true)
    await naming.evaluate(ref, "job_structural")
    await naming.evaluate(ref, "job_duplicate")
    expect(checkpoints).toEqual([
      { checkpoint: 3, forced: true },
      { checkpoint: 6, forced: true },
      { checkpoint: 6, forced: true },
    ])
  })

  test("membership structure changing during AI invalidates the old decision", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue" })
    const ref = { workspaceId: item.workspaceId, targetKind: "conversation" as const, targetId: item.conversationId }
    let calls = 0
    let naming: DynamicNamingService
    naming = service(async () => {
      calls += 1
      if (calls === 1) await naming.recordStructuralEvent(ref, "9100")
      return { action: "rename", title: calls === 1 ? "Stale membership title" : "Current membership title" }
    })
    expect(await naming.evaluate(ref, "job_before_move")).toEqual({ status: "stale" })
    expect(await naming.evaluate(ref, "job_after_move")).toMatchObject({ status: "evaluated", action: "rename" })
    expect(await ConversationRepository.findById(pool, item.conversationId)).toMatchObject({
      topicSummary: "Current membership title",
    })
  })

  test("a manual rename during evaluation wins", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue" })
    const naming = service(async () => {
      await ConversationRepository.updateTopicSummary(pool, {
        workspaceId: item.workspaceId,
        conversationId: item.conversationId,
        topicSummary: "My rollback plan",
        source: "explicit",
        updatedByUserId: item.userId,
      })
      return { action: "rename", title: "Stale model title" }
    })
    expect(
      await naming.evaluate(
        { workspaceId: item.workspaceId, targetKind: "conversation", targetId: item.conversationId },
        "job_manual"
      )
    ).toEqual({ status: "stale" })
    expect(await ConversationRepository.findById(pool, item.conversationId)).toMatchObject({
      topicSummary: "My rollback plan",
      topicSummarySource: "explicit",
    })
  })
})
