/**
 * Agent-block attribution (PR5): a message carrying an `agentBlock` is marked
 * server-side with the agents it credits, on the real `messages.metadata`
 * column and through the metadata filter the API queries with (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import {
  EventService,
  MessageRepository,
  MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY,
  messageMetadataSchema,
} from "../../src/features/messaging"
import { userId, workspaceId } from "../../src/lib/id"
import type { JSONContent } from "@threahq/types"

describe("Agent block metadata", () => {
  let pool: Pool
  let eventService: EventService
  let streamService: StreamService
  let wsId: string
  let author: string
  let streamId: string

  const AGENT_ID = "persona_01ARIADNE"

  function contentWithAgentBlock(text: string): { contentJson: JSONContent; contentMarkdown: string } {
    return {
      contentJson: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "sending this along:" }] },
          {
            type: "agentBlock",
            attrs: { authorId: AGENT_ID, authorName: "Ariadne" },
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          },
        ],
      },
      contentMarkdown: `sending this along:\n\n> — [Ariadne](agent:${AGENT_ID})\n>\n> ${text}`,
    }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    streamService = new StreamService(pool)
    wsId = workspaceId()
    await withTransaction(pool, async (client) => {
      author = (await addTestMember(client, wsId, userId())).id
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Agent Block Test Workspace",
        slug: `agent-block-ws-${wsId.toLowerCase()}`,
        createdBy: author,
      })
    })
    const stream = await streamService.createChannel({
      workspaceId: wsId,
      slug: `agent-block-${wsId.toLowerCase()}`,
      visibility: "public",
      createdBy: author,
    })
    streamId = stream.id
  })

  afterAll(async () => {
    await pool.end()
  })

  test("stamps the credited agent on a message that carries an agent block", async () => {
    const created = await eventService.createMessage({
      workspaceId: wsId,
      streamId,
      authorId: author,
      authorType: "user",
      metadata: { source: "composer" },
      ...contentWithAgentBlock("Two options."),
    })

    const stored = await MessageRepository.findById(pool, created.id)
    expect(stored?.metadata).toEqual({
      source: "composer",
      [MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY]: AGENT_ID,
    })
  })

  test("finds the message through the metadata filter the API queries with", async () => {
    const created = await eventService.createMessage({
      workspaceId: wsId,
      streamId,
      authorId: author,
      authorType: "user",
      ...contentWithAgentBlock("Ship the smaller one."),
    })

    const found = await MessageRepository.findByMetadata(pool, {
      streamIds: [streamId],
      filter: { [MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY]: AGENT_ID },
      limit: 10,
    })

    expect(found.map((m) => m.id)).toContain(created.id)
  })

  test("leaves a plain message unmarked, and a caller cannot forge the marker", async () => {
    const created = await eventService.createMessage({
      workspaceId: wsId,
      streamId,
      authorId: author,
      authorType: "user",
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "just me" }] }] },
      contentMarkdown: "just me",
    })

    const stored = await MessageRepository.findById(pool, created.id)
    expect(stored?.metadata).toEqual({})
    expect(messageMetadataSchema.safeParse({ [MESSAGE_METADATA_AGENT_BLOCK_AUTHORS_KEY]: AGENT_ID }).success).toBe(
      false
    )
  })
})
