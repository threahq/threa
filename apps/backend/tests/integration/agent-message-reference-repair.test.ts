import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { parseMarkdown, repairMessageReferences } from "@threahq/prosemirror"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { listAccessibleStreamIds, StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, withTestTransaction } from "./setup"

const textDoc = (text: string) => ({
  type: "doc" as const,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

describe("agent message reference repair", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("repairs through the scoped repository and persists on create and edit", async () => {
    await withTestTransaction(pool, async (client) => {
      const ws = workspaceId()
      const actorWorkosId = userId()
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Agent reference repair",
        slug: `agent-reference-repair-${ws}`,
        createdBy: actorWorkosId,
      })
      const actor = await addTestMember(client, ws, actorWorkosId)
      const sourceStreamId = streamId()
      const targetStreamId = streamId()
      for (const id of [sourceStreamId, targetStreamId]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: "channel",
          visibility: "private",
          createdBy: actor.id,
        })
        await StreamMemberRepository.insert(client, id, actor.id)
      }

      const service = new EventService(client)
      const source = await service.createMessage({
        workspaceId: ws,
        streamId: sourceStreamId,
        authorId: actor.id,
        authorType: "user",
        contentJson: textDoc("source"),
        contentMarkdown: "source",
      })
      const resolve = async (scopedWorkspaceId: string, ids: string[]) => {
        const messages = await MessageRepository.findByIdsInStreams(client, scopedWorkspaceId, ids, [sourceStreamId])
        return new Map(
          [...messages.values()].map((message) => [message.id, { messageId: message.id, streamId: message.streamId }])
        )
      }

      const createdMarkdown = await repairMessageReferences(`See ${source.id}`, ws, resolve)
      const created = await service.createMessage({
        workspaceId: ws,
        streamId: targetStreamId,
        authorId: actor.id,
        authorType: "user",
        contentJson: parseMarkdown(createdMarkdown),
        contentMarkdown: createdMarkdown,
      })
      expect((await MessageRepository.findById(client, created.id))?.contentMarkdown).toBe(
        `See [${source.id}](shared-message:${sourceStreamId}/${source.id})`
      )

      const editedMarkdown = await repairMessageReferences(`[source](message:${source.id})`, ws, resolve)
      await service.editMessageInternal({
        workspaceId: ws,
        streamId: targetStreamId,
        messageId: created.id,
        actorId: actor.id,
        contentJson: parseMarkdown(editedMarkdown),
        contentMarkdown: editedMarkdown,
      })
      expect((await MessageRepository.findById(client, created.id))?.contentMarkdown).toBe(
        `[source](shared-message:${sourceStreamId}/${source.id})`
      )
    })
  })

  test("keeps inaccessible, cross-workspace, deleted, and mismatched references unchanged while resolving an inherited thread", async () => {
    await withTestTransaction(pool, async (client) => {
      const ws = workspaceId()
      const foreignWs = workspaceId()
      const actorWorkosId = userId()
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Agent repair scope",
        slug: `agent-repair-scope-${ws}`,
        createdBy: actorWorkosId,
      })
      await WorkspaceRepository.insert(client, {
        id: foreignWs,
        name: "Foreign repair scope",
        slug: `foreign-agent-repair-${foreignWs}`,
        createdBy: actorWorkosId,
      })
      const actor = await addTestMember(client, ws, actorWorkosId)
      const foreignActor = await addTestMember(client, foreignWs, userId())
      const rootId = streamId()
      const threadId = streamId()
      const inaccessibleId = streamId()
      const foreignStreamId = streamId()
      await StreamRepository.insert(client, {
        id: rootId,
        workspaceId: ws,
        type: "channel",
        visibility: "private",
        createdBy: actor.id,
      })
      await StreamMemberRepository.insert(client, rootId, actor.id)
      const service = new EventService(client)
      const rootMessage = await service.createMessage({
        workspaceId: ws,
        streamId: rootId,
        authorId: actor.id,
        authorType: "user",
        contentJson: textDoc("root"),
        contentMarkdown: "root",
      })
      await StreamRepository.insert(client, {
        id: threadId,
        workspaceId: ws,
        type: "thread",
        visibility: "private",
        parentStreamId: rootId,
        parentAnchorId: rootMessage.id,
        rootStreamId: rootId,
        createdBy: actor.id,
      })
      await StreamRepository.insert(client, {
        id: inaccessibleId,
        workspaceId: ws,
        type: "channel",
        visibility: "private",
        createdBy: actor.id,
      })
      await StreamRepository.insert(client, {
        id: foreignStreamId,
        workspaceId: foreignWs,
        type: "channel",
        visibility: "private",
        createdBy: foreignActor.id,
      })

      const createSource = (workspace: string, stream: string, authorId: string, content: string) =>
        new EventService(client).createMessage({
          workspaceId: workspace,
          streamId: stream,
          authorId,
          authorType: "user",
          contentJson: textDoc(content),
          contentMarkdown: content,
        })
      const inherited = await createSource(ws, threadId, actor.id, "inherited")
      const inaccessible = await createSource(ws, inaccessibleId, actor.id, "inaccessible")
      const deleted = await createSource(ws, rootId, actor.id, "deleted")
      const foreign = await createSource(foreignWs, foreignStreamId, foreignActor.id, "foreign")
      await MessageRepository.softDelete(client, deleted.id)

      const accessible = await listAccessibleStreamIds(client, ws, actor.id, [rootId, threadId, inaccessibleId])
      expect(accessible).toEqual(new Set([rootId, threadId]))
      const resolve = async (scopedWorkspaceId: string, ids: string[]) => {
        const messages = await MessageRepository.findByIdsInStreams(client, scopedWorkspaceId, ids, [
          ...accessible,
          foreignStreamId,
        ])
        return new Map(
          [...messages.values()].map((message) => [message.id, { messageId: message.id, streamId: message.streamId }])
        )
      }
      const input = [
        inherited.id,
        inaccessible.id,
        deleted.id,
        foreign.id,
        `[mismatch](message:${rootId}/${inherited.id})`,
      ].join(" ")

      expect(await repairMessageReferences(input, ws, resolve)).toBe(
        `[${inherited.id}](shared-message:${threadId}/${inherited.id}) ${inaccessible.id} ${deleted.id} ${foreign.id} [mismatch](message:${rootId}/${inherited.id})`
      )
    })
  })
})
