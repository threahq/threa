/**
 * A subagent's thread is a sub-conversation of the one it was delegated from,
 * never a new top-level board card.
 *
 * Board nesting is derived on the client from the stream graph, and that
 * derivation only reaches threads anchored on a member MESSAGE. A subagent's
 * thread is anchored on the `subagent:created` CARD, so nothing links it — the
 * fix is a written-down `conversations.parent_conversation_id`, which this
 * pins against the real schema (INV-68): the column has existed since 2025 with
 * no writer, so a statement that never runs would look exactly like a pass.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { ConversationIntents, ConversationStatuses } from "@threa/types"
import { MessageRepository } from "../../src/features/messaging"
import { ConversationRepository, conversationAssigner } from "../../src/features/conversations"
import { BoundaryExtractionService, type BoundaryExtractor } from "../../src/features/conversations"
import { SubagentService } from "../../src/features/subagents"
import { StreamRepository } from "../../src/features/streams"
import { conversationId, messageId } from "../../src/lib/id"
import { withTransaction } from "../../src/db"
import { setupIsolatedTestDatabase, testMessageContent } from "./setup"
import { createParams, createSubagentTestContext, type SubagentTestContext } from "./subagent-support"

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService
let extractionService: BoundaryExtractionService
let sequence = 1

/** Always "open a new topic" — the mint branch is what this suite is about. */
const alwaysNewTopic: BoundaryExtractor = {
  async extract() {
    return {
      assignments: [{ conversationId: null, isPrimary: true }],
      newConversationTopic: "Second opinion",
      confidence: 0.9,
    }
  },
} as unknown as BoundaryExtractor

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-board-nesting")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "board-nesting")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
  extractionService = new BoundaryExtractionService(pool, alwaysNewTopic)
})

afterAll(async () => {
  await cleanup()
})

/** The topic the delegation was asked inside of. */
async function seedSourceConversation(streamId: string): Promise<string> {
  const id = conversationId()
  await withTransaction(pool, (client) =>
    ConversationRepository.insert(client, {
      id,
      streamId,
      workspaceId: ctx.workspaceId,
      confidence: 1,
      status: ConversationStatuses.ACTIVE,
    })
  )
  return id
}

/** Send a message that DECLARES a new topic — the production mint entry point. */
async function mintConversationFor(streamId: string, authorId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const message = await MessageRepository.insert(client, {
      id: messageId(),
      streamId,
      sequence: sequence++,
      authorId,
      authorType: "user",
      ...testMessageContent("Take a look at this"),
    })
    return conversationAssigner.assignInTransaction(client, {
      workspaceId: ctx.workspaceId,
      message,
      directive: { intent: ConversationIntents.NEW },
      initiatingUserId: authorId,
    })
  })
}

describe("conversations minted inside a subagent thread", () => {
  test("carry the run's source conversation as their parent", async () => {
    const channel = await ctx.createChannel({ slug: "nesting", memberIds: [ctx.owner] })
    const sourceConversationId = await seedSourceConversation(channel.id)

    const run = await subagentService.create({
      ...createParams(ctx, channel.id),
      sourceConversationId,
    })

    const mintedId = await mintConversationFor(run.threadStreamId, ctx.owner)
    const minted = await ConversationRepository.findById(pool, mintedId)

    expect(minted?.parentConversationId).toBe(sourceConversationId)
  })

  test("carry no parent when the delegation was not anchored to a topic", async () => {
    const channel = await ctx.createChannel({ slug: "nesting-untopiced", memberIds: [ctx.owner] })
    const run = await subagentService.create({ ...createParams(ctx, channel.id), sourceConversationId: null })

    const mintedId = await mintConversationFor(run.threadStreamId, ctx.owner)
    const minted = await ConversationRepository.findById(pool, mintedId)

    expect(minted?.parentConversationId).toBeNull()
  })

  test("carry the parent when the subagent itself opens the conversation (agent reply)", async () => {
    // The likeliest mint of all: the delegated model speaks first in its thread.
    const channel = await ctx.createChannel({ slug: "nesting-agent-reply", memberIds: [ctx.owner] })
    const sourceConversationId = await seedSourceConversation(channel.id)
    const run = await subagentService.create({ ...createParams(ctx, channel.id), sourceConversationId })

    const reply = await withTransaction(pool, (client) =>
      MessageRepository.insert(client, {
        id: messageId(),
        streamId: run.threadStreamId,
        sequence: sequence++,
        authorId: ctx.persona.id,
        authorType: "persona",
        ...testMessageContent("Before I commit to a recommendation…"),
      })
    )
    const minted = await extractionService.processMessage(reply.id, run.threadStreamId, ctx.workspaceId)

    expect(minted?.parentConversationId).toBe(sourceConversationId)
  })

  test("carry the parent when the extractor opens a new topic in the thread", async () => {
    const channel = await ctx.createChannel({ slug: "nesting-extracted", memberIds: [ctx.owner] })
    const sourceConversationId = await seedSourceConversation(channel.id)
    const run = await subagentService.create({ ...createParams(ctx, channel.id), sourceConversationId })

    const reply = await withTransaction(pool, (client) =>
      MessageRepository.insert(client, {
        id: messageId(),
        streamId: run.threadStreamId,
        sequence: sequence++,
        authorId: ctx.owner,
        authorType: "user",
        ...testMessageContent("Per-stream ordering is hard."),
      })
    )
    const minted = await extractionService.processMessage(reply.id, run.threadStreamId, ctx.workspaceId)

    expect(minted?.parentConversationId).toBe(sourceConversationId)
  })

  test("leave message-anchored threads alone — the graph already derives those", async () => {
    const channel = await ctx.createChannel({ slug: "nesting-msg-anchor", memberIds: [ctx.owner] })
    const anchorMessageId = await withTransaction(pool, async (client) => {
      const message = await MessageRepository.insert(client, {
        id: messageId(),
        streamId: channel.id,
        sequence: sequence++,
        authorId: ctx.owner,
        authorType: "user",
        ...testMessageContent("anchor"),
      })
      return message.id
    })
    const thread = await ctx.streamService.createThread({
      workspaceId: ctx.workspaceId,
      parentStreamId: channel.id,
      parentAnchorId: anchorMessageId,
      createdBy: ctx.owner,
      principal: { kind: "user", userId: ctx.owner },
    })

    const mintedId = await mintConversationFor(thread.id, ctx.owner)
    const minted = await ConversationRepository.findById(pool, mintedId)

    expect(minted?.parentConversationId).toBeNull()
    // Guard against the thread silently not being a thread.
    expect((await StreamRepository.findById(pool, thread.id))?.parentAnchorId).toBe(anchorMessageId)
  })
})
