import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { parseMarkdown } from "@threahq/prosemirror"
import { personaId } from "@threahq/backend-common"
import { buildAgentMessageContent } from "../../src/features/agents"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, withTestTransaction } from "./setup"

describe("agent message content", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should store a persona reply without the pointer when it cites a message outside the agent's reach", async () => {
    await withTestTransaction(pool, async (client) => {
      const ws = workspaceId()
      const ownerWorkosId = userId()
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Agent message content",
        slug: `agent-message-content-${ws}`,
        createdBy: ownerWorkosId,
      })
      const owner = await addTestMember(client, ws, ownerWorkosId)
      const targetStreamId = streamId()
      const sourceStreamId = streamId()
      for (const id of [targetStreamId, sourceStreamId]) {
        await StreamRepository.insert(client, {
          id,
          workspaceId: ws,
          type: "channel",
          visibility: "private",
          createdBy: owner.id,
        })
        await StreamMemberRepository.insert(client, ws, id, owner.id)
      }

      const service = new EventService(client as unknown as Pool)
      const source = await service.createMessage({
        workspaceId: ws,
        streamId: sourceStreamId,
        authorId: owner.id,
        authorType: "user",
        contentJson: parseMarkdown("source"),
        contentMarkdown: "source",
      })

      const prose = "The rollout moved to Friday."
      const pointerTarget = `shared-message:${sourceStreamId}/${source.id}`
      const content = `${prose}\n\nShared a message from [Owner](${pointerTarget})`
      const persona = personaId()
      const send = async (accessibleStreamIds: string[]) => {
        const message = await service.createMessage({
          workspaceId: ws,
          streamId: targetStreamId,
          authorId: persona,
          authorType: "persona",
          ...(await buildAgentMessageContent({
            pool: client as unknown as Pool,
            workspaceId: ws,
            streamId: targetStreamId,
            content,
            accessibleStreamIds,
          })),
          accessibleStreamIds,
        })
        return (await MessageRepository.findById(client, ws, message.id))?.contentMarkdown
      }

      await expect(
        service.createMessage({
          workspaceId: ws,
          streamId: targetStreamId,
          authorId: persona,
          authorType: "persona",
          contentJson: parseMarkdown(content),
          contentMarkdown: content,
        })
      ).rejects.toMatchObject({ code: "REFERENCE_SOURCE_NOT_FOUND" })

      expect({
        outOfReach: await send([targetStreamId]),
        inReach: await send([targetStreamId, sourceStreamId]),
      }).toEqual({
        outOfReach: prose,
        inReach: `${prose}\n\nShared a message from [Owner](${pointerTarget}?v=1)`,
      })
    })
  })
})
