/**
 * Ingestion-time mention resolution against the real schema (INV-64, INV-68):
 * a bare slug that names a member or channel becomes a pointer, one that names
 * nothing is stored as the text it was typed as.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { JSONContent } from "@threahq/types"

import { setupTestDatabase, withTransaction } from "./setup"
import { StreamRepository, StreamMemberRepository } from "../../src/features/streams"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { userId, workspaceId, streamId } from "../../src/lib/id"

describe("mention ingestion", () => {
  let pool: Pool
  let eventService: EventService
  let testWorkspaceId: string
  let author: { id: string; slug: string }
  let channel: { id: string; slug: string }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    testWorkspaceId = workspaceId()
    const channelId = streamId()
    channel = { id: channelId, slug: `general-${channelId.slice(-8).toLowerCase()}` }

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Mention Ingestion",
        slug: `mention-ingestion-${testWorkspaceId}`,
        createdBy: userId(),
      })
      const authorId = userId()
      author = await UserRepository.insert(client, {
        id: authorId,
        workspaceId: testWorkspaceId,
        workosUserId: authorId,
        email: `${authorId.toLowerCase()}@test.local`,
        name: "Pierre",
        role: "member",
        slug: `pierre-${authorId.slice(-8).toLowerCase()}`,
      })
      await StreamRepository.insert(client, {
        id: channel.id,
        workspaceId: testWorkspaceId,
        type: "channel",
        visibility: "public",
        slug: channel.slug,
        createdBy: author.id,
      })
      await StreamMemberRepository.insert(client, channel.id, author.id)
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("resolves known slugs to pointers and stores unknown ones as plain text", async () => {
    const contentJson: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: author.slug, slug: author.slug, mentionType: "user" } },
            { type: "text", text: " and " },
            {
              type: "mention",
              attrs: { id: "nobody", slug: "nobody", mentionType: "user" },
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " in " },
            { type: "channelLink", attrs: { id: channel.slug, slug: channel.slug } },
            { type: "text", text: " not " },
            { type: "channelLink", attrs: { id: "nowhere", slug: "nowhere" } },
          ],
        },
      ],
    }

    const message = await eventService.createMessage({
      workspaceId: testWorkspaceId,
      streamId: channel.id,
      authorId: author.id,
      authorType: "user",
      contentJson,
      contentMarkdown: `@${author.slug} and **@nobody** in #${channel.slug} not #nowhere`,
    })

    const stored = await MessageRepository.findById(pool, message.id)
    expect({ contentJson: stored!.contentJson, contentMarkdown: stored!.contentMarkdown }).toEqual({
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: author.id, slug: author.slug, mentionType: "user" } },
              { type: "text", text: " and " },
              { type: "text", text: "@nobody", marks: [{ type: "bold" }] },
              { type: "text", text: " in " },
              { type: "channelLink", attrs: { id: channel.id, slug: channel.slug } },
              { type: "text", text: " not " },
              { type: "text", text: "#nowhere" },
            ],
          },
        ],
      },
      contentMarkdown: `[@${author.slug}](user:${author.id}) and **@nobody** in [#${channel.slug}](channel:${channel.id}) not #nowhere`,
    })
  })
})
