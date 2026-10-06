import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { streamConnectionId } from "@threahq/backend-common"
import { Pool, type PoolClient } from "pg"
import { withTransaction } from "../../src/db"
import { ConversationRepository } from "../../src/features/conversations"
import {
  DynamicNamingConversationTarget,
  DynamicNamingService,
  type DynamicNamingDecision,
  type DynamicNamingEvaluationInput,
} from "../../src/features/dynamic-naming"
import { MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { MessageFormatter } from "../../src/lib/ai/message-formatter"
import { conversationId, eventId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, seedCompletedLinkPreview, setupTestDatabase, testMessageContent } from "./setup"

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
    /** Records the title as written while the stream was shared. */
    sharedTitle?: boolean
  }): Promise<Fixture> {
    const ws = workspaceId()
    const workosUserId = userId()
    const stream = streamId()
    const conversation = conversationId()
    let user = ""
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Conversation Naming Workspace",
        slug: `conversation-naming-${ws}`,
        createdBy: workosUserId,
      })
      user = (await addTestMember(client, ws, workosUserId)).id
      await StreamRepository.insert(client, {
        id: stream,
        workspaceId: ws,
        type: params.streamType ?? "channel",
        slug: params.streamType === "scratchpad" ? undefined : `channel-${stream}`,
        visibility: "private",
        companionMode: "off",
        createdBy: user,
      })
      await StreamMemberRepository.insert(client, ws, stream, user)
      await ConversationRepository.insert(client, {
        id: conversation,
        streamId: stream,
        workspaceId: ws,
        topicSummary: params.title,
        topicSummarySource: params.title ? "generated" : undefined,
        sharedRootStreamId: params.sharedTitle ? stream : undefined,
      })
      for (let sequence = 1; sequence <= params.count; sequence += 1) {
        const id = messageId()
        await MessageRepository.insert(client, {
          workspaceId: ws,
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

  async function share(db: Pool | PoolClient, item: Fixture) {
    await db.query(
      `INSERT INTO stream_connections (workspace_id, id, role, state, stream_id, remote_workspace_id, remote_workspace_name, expires_at, revision)
       VALUES ($1, $2, 'host', 'active', $3, $4, 'Partner', NOW() + INTERVAL '1 day', 1)`,
      [item.workspaceId, streamConnectionId(), item.streamId, workspaceId()]
    )
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
        {
          workspaceId: item.workspaceId,
          targetKind: "conversation",
          targetId: item.conversationId,
          initiatingUserId: item.userId,
        },
        "job_refine"
      )
    ).toMatchObject({ status: "evaluated", action: "rename" })
    expect(checkpoint).toBe(3)
    expect(await ConversationRepository.findById(pool, item.workspaceId, item.conversationId)).toMatchObject({
      topicSummary: "Deployment rollback",
      topicSummarySource: "generated",
      topicSummaryRevision: 2,
    })
  })

  test("should pass sibling conversation titles from the same stream to the decider", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue" })
    await ConversationRepository.insert(pool, {
      id: conversationId(),
      streamId: item.streamId,
      workspaceId: item.workspaceId,
      topicSummary: "Database migration plan",
      topicSummarySource: "generated",
    })
    let existingTitles: string[] | null = null
    const naming = service(async (input) => {
      existingTitles = input.existingTitles
      return { action: "keep" }
    })
    await naming.evaluate(
      {
        workspaceId: item.workspaceId,
        targetKind: "conversation",
        targetId: item.conversationId,
        initiatingUserId: item.userId,
      },
      "job_siblings"
    )
    expect(existingTitles).toEqual(["Database migration plan"])
  })

  test("should name a conversation from what the partner reads when its channel is shared", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue", sharedTitle: true })
    const outside = streamId()
    const linkId = messageId()
    const prUrl = "https://github.com/acme/private/pull/7"
    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: outside,
        workspaceId: item.workspaceId,
        type: "channel",
        slug: "secret-plans",
        visibility: "private",
        companionMode: "off",
        createdBy: item.userId,
      })
      await MessageRepository.insert(client, {
        workspaceId: item.workspaceId,
        id: linkId,
        streamId: item.streamId,
        sequence: 4n,
        authorId: item.userId,
        authorType: "user",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "rollback notes are in " },
                { type: "channelLink", attrs: { id: outside, slug: "secret-plans" } },
                { type: "text", text: ` per ${prUrl}` },
              ],
            },
          ],
        },
        contentMarkdown: `rollback notes are in [#secret-plans](channel:${outside}) per ${prUrl}`,
      })
      await seedCompletedLinkPreview(client, {
        workspaceId: item.workspaceId,
        messageId: linkId,
        url: prUrl,
        title: "Rotate the prod password",
      })
      await ConversationRepository.addPrimaryMessage(client, item.workspaceId, item.conversationId, linkId, item.userId)
      for (const [anchor, title] of [
        [linkId, "Rollback thread"],
        [eventId(), "Card work"],
      ]) {
        const thread = streamId()
        await StreamRepository.insert(client, {
          id: thread,
          workspaceId: item.workspaceId,
          type: "thread",
          parentStreamId: item.streamId,
          rootStreamId: item.streamId,
          parentAnchorId: anchor,
          visibility: "private",
          companionMode: "off",
          createdBy: item.userId,
        })
        await ConversationRepository.insert(client, {
          id: conversationId(),
          streamId: thread,
          workspaceId: item.workspaceId,
          topicSummary: title,
          topicSummarySource: "generated",
          sharedRootStreamId: item.streamId,
        })
      }
      await share(client, item)
    })
    let seen: { linksOutside: boolean; mentionsSlug: boolean; preview: boolean; existingTitles: string[] } | null = null
    const naming = service(async (input) => {
      seen = {
        linksOutside: input.context.includes(outside),
        mentionsSlug: input.context.includes("#secret-plans"),
        preview: input.context.includes("Rotate the prod password"),
        existingTitles: input.existingTitles,
      }
      return { action: "keep" }
    })

    await naming.evaluate(
      {
        workspaceId: item.workspaceId,
        targetKind: "conversation",
        targetId: item.conversationId,
        initiatingUserId: item.userId,
      },
      "job_shared"
    )

    expect(seen).toEqual({
      linksOutside: false,
      mentionsSlug: true,
      preview: false,
      existingTitles: ["Rollback thread"],
    })
  })

  test("should name from what the partner reads when the newest messages of a shared conversation are deleted", async () => {
    const item = await fixture({ count: 3, title: "Deployment issue", sharedTitle: true })
    await withTransaction(pool, async (client) => {
      for (let sequence = 4; sequence <= 13; sequence += 1) {
        const id = messageId()
        await MessageRepository.insert(client, {
          workspaceId: item.workspaceId,
          id,
          streamId: item.streamId,
          sequence: BigInt(sequence),
          authorId: item.userId,
          authorType: "user",
          ...testMessageContent(`Acquire Initech quietly, step ${sequence}`),
        })
        await ConversationRepository.addPrimaryMessage(client, item.workspaceId, item.conversationId, id, item.userId)
        await MessageRepository.softDelete(client, item.workspaceId, id)
      }
      await share(client, item)
    })
    let seen: { deleted: boolean; kept: boolean[] } | null = null
    const naming = service(async (input) => {
      seen = {
        deleted: input.context.includes("Acquire Initech"),
        kept: [1, 2, 3].map((sequence) => input.context.includes(`Message ${sequence} about deployment rollback`)),
      }
      return { action: "keep" }
    })

    await naming.evaluate(
      {
        workspaceId: item.workspaceId,
        targetKind: "conversation",
        targetId: item.conversationId,
        initiatingUserId: item.userId,
      },
      "job_shared_deleted"
    )

    expect(seen).toEqual({ deleted: false, kept: [true, true, true] })
  })

  test("should withhold a title and summary written before the share, and stamp the rename, when the channel is shared", async () => {
    const item = await fixture({ count: 3, title: "Initech plan" })
    await ConversationRepository.update(pool, item.workspaceId, item.conversationId, {
      summary: "Acquire Initech quietly",
    })
    for (const [title, sharedRootStreamId] of [
      ["Acme merger", undefined],
      ["Release checklist", item.streamId],
    ]) {
      await ConversationRepository.insert(pool, {
        id: conversationId(),
        streamId: item.streamId,
        workspaceId: item.workspaceId,
        topicSummary: title,
        topicSummarySource: "generated",
        sharedRootStreamId,
      })
    }
    await share(pool, item)
    let seen: { currentTitle: string | null; summary: boolean; existingTitles: string[] } | null = null
    const naming = service(async (input) => {
      seen = {
        currentTitle: input.currentTitle,
        summary: input.context.includes("Acquire Initech"),
        existingTitles: input.existingTitles,
      }
      return { action: "rename", title: "Deployment rollback" }
    })

    await naming.evaluate(
      {
        workspaceId: item.workspaceId,
        targetKind: "conversation",
        targetId: item.conversationId,
        initiatingUserId: item.userId,
      },
      "job_shared_pre_share"
    )

    const renamed = await ConversationRepository.findById(pool, item.workspaceId, item.conversationId)
    const stamps = await ConversationRepository.findSharedStamps(pool, item.workspaceId, [item.conversationId])
    expect({ seen, title: renamed?.topicSummary, stamps: stamps.get(item.conversationId) }).toEqual({
      seen: { currentTitle: null, summary: false, existingTitles: ["Release checklist"] },
      title: "Deployment rollback",
      stamps: { topicSummarySharedRootStreamId: item.streamId, summarySharedRootStreamId: null },
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
      {
        workspaceId: item.workspaceId,
        targetKind: "conversation",
        targetId: item.conversationId,
        initiatingUserId: item.userId,
      },
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
        {
          workspaceId: item.workspaceId,
          targetKind: "conversation",
          targetId: item.conversationId,
          initiatingUserId: item.userId,
        },
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
      initiatingUserId: item.userId,
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
    const ref = {
      workspaceId: item.workspaceId,
      targetKind: "conversation" as const,
      targetId: item.conversationId,
      initiatingUserId: item.userId,
    }
    await naming.evaluate(ref, "job_cp3")
    await withTransaction(pool, async (client) => {
      for (let sequence = 4; sequence <= 6; sequence += 1) {
        const id = messageId()
        await MessageRepository.insert(client, {
          workspaceId: item.workspaceId,
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
    const ref = {
      workspaceId: item.workspaceId,
      targetKind: "conversation" as const,
      targetId: item.conversationId,
      initiatingUserId: item.userId,
    }
    let calls = 0
    let naming: DynamicNamingService
    naming = service(async () => {
      calls += 1
      if (calls === 1) await naming.recordStructuralEvent(ref, "9100")
      return { action: "rename", title: calls === 1 ? "Stale membership title" : "Current membership title" }
    })
    expect(await naming.evaluate(ref, "job_before_move")).toEqual({ status: "stale" })
    expect(await naming.evaluate(ref, "job_after_move")).toMatchObject({ status: "evaluated", action: "rename" })
    expect(await ConversationRepository.findById(pool, item.workspaceId, item.conversationId)).toMatchObject({
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
        sharedRootStreamId: null,
        updatedByUserId: item.userId,
      })
      return { action: "rename", title: "Stale model title" }
    })
    expect(
      await naming.evaluate(
        {
          workspaceId: item.workspaceId,
          targetKind: "conversation",
          targetId: item.conversationId,
          initiatingUserId: item.userId,
        },
        "job_manual"
      )
    ).toEqual({ status: "stale" })
    expect(await ConversationRepository.findById(pool, item.workspaceId, item.conversationId)).toMatchObject({
      topicSummary: "My rollback plan",
      topicSummarySource: "explicit",
    })
  })
})
