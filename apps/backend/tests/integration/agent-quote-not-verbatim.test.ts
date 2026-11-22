import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool, PoolClient } from "pg"
import { parseMarkdown } from "@threahq/prosemirror"
import { MessageReferenceErrorCodes, type JSONContent } from "@threahq/types"
import { buildAgentMessageContent } from "../../src/features/agents/companion/agent-message-content"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, refusal, setupTestDatabase, withTestTransaction } from "./setup"

const SOURCE_TEXT = "We ship the migration on Friday after the freeze lifts."
const PERSONA_ID = "persona_quoter"

function findQuotes(node: JSONContent): Array<Record<string, unknown>> {
  const own = node.type === "quoteReply" ? [node.attrs ?? {}] : []
  return [...own, ...(node.content ?? []).flatMap(findQuotes)]
}

async function seed(client: PoolClient, sourceMarkdown = SOURCE_TEXT) {
  const ws = workspaceId()
  const actorWorkosId = userId()
  await WorkspaceRepository.insert(client, {
    id: ws,
    name: "Agent quote",
    slug: `agent-quote-${ws}`,
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
    await StreamMemberRepository.insert(client, ws, id, actor.id)
  }
  const service = new EventService(client)
  const source = await service.createMessage({
    workspaceId: ws,
    streamId: sourceStreamId,
    authorId: actor.id,
    authorType: "user",
    contentJson: parseMarkdown(sourceMarkdown),
    contentMarkdown: sourceMarkdown,
  })
  const quoteMarkdown = (snippet: string, quotedStreamId = sourceStreamId, messageId: string = source.id) =>
    `Context first.\n\n> ${snippet}\n>\n> — [Alice](quote:${quotedStreamId}/${messageId}/${actor.id}/user)\n\nAfterwards.`
  const sendAsAgent = async (markdown: string, accessibleStreamIds = [sourceStreamId, targetStreamId]) => {
    const content = await buildAgentMessageContent({
      pool: client as unknown as Pool,
      workspaceId: ws,
      streamId: targetStreamId,
      content: markdown,
      accessibleStreamIds,
    })
    const created = await service.createMessage({
      workspaceId: ws,
      streamId: targetStreamId,
      authorId: PERSONA_ID,
      authorType: "persona",
      contentJson: content.contentJson,
      contentMarkdown: content.contentMarkdown,
      accessibleStreamIds,
    })
    return (await MessageRepository.findById(client, ws, created.id))!
  }
  return { ws, actor, service, source, sourceStreamId, targetStreamId, quoteMarkdown, sendAsAgent }
}

describe("agent quote that is not verbatim", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a paraphrased cross-stream quote is pinned to the whole source message", async () => {
    await withTestTransaction(pool, async (client) => {
      const { source, sourceStreamId, quoteMarkdown, sendAsAgent } = await seed(client)

      const stored = await sendAsAgent(quoteMarkdown("We ship it Friday"))

      expect(
        findQuotes(stored.contentJson).map(({ messageId, streamId, snippet, version, range }) => ({
          messageId,
          streamId,
          snippet,
          version,
          range,
        }))
      ).toEqual([
        { messageId: source.id, streamId: sourceStreamId, snippet: SOURCE_TEXT, version: source.revision, range: null },
      ])
    })
  })

  test("a paraphrased quote of a formatted multi-block message is pinned to the whole source", async () => {
    await withTestTransaction(pool, async (client) => {
      const sourceMarkdown =
        "We ship the **migration** on Friday.\n\n- freeze lifts first\n- then `deploy`\n\n```ts\nconst done = true\n```"
      const { source, quoteMarkdown, sendAsAgent } = await seed(client, sourceMarkdown)

      const stored = await sendAsAgent(quoteMarkdown("Migration ships Friday once the freeze is over"))

      expect(
        findQuotes(stored.contentJson).map(({ snippet, version, range }) => ({ snippet, version, range }))
      ).toEqual([{ snippet: sourceMarkdown, version: source.revision, range: null }])
    })
  })

  test("a paraphrased quote of a deleted message is dropped, not widened to the deleted text", async () => {
    await withTestTransaction(pool, async (client) => {
      const { ws, source, quoteMarkdown, sendAsAgent } = await seed(client)
      await MessageRepository.softDelete(client, ws, source.id)

      const stored = await sendAsAgent(quoteMarkdown("We ship it Friday"))

      expect({ quotes: findQuotes(stored.contentJson), markdown: stored.contentMarkdown }).toEqual({
        quotes: [],
        markdown: "Context first.\n\nAfterwards.",
      })
    })
  })

  test("a verbatim partial quote is pinned to that span", async () => {
    await withTestTransaction(pool, async (client) => {
      const { source, quoteMarkdown, sendAsAgent } = await seed(client)

      const stored = await sendAsAgent(quoteMarkdown("the migration on Friday"))

      const [quote] = findQuotes(stored.contentJson)
      expect({ snippet: quote?.snippet, version: quote?.version, hasRange: quote?.range != null }).toEqual({
        snippet: "the migration on Friday",
        version: source.revision,
        hasRange: true,
      })
    })
  })

  test("a same-stream quote of an unknown message is dropped and the prose ships", async () => {
    await withTestTransaction(pool, async (client) => {
      const { targetStreamId, quoteMarkdown, sendAsAgent } = await seed(client)

      const stored = await sendAsAgent(quoteMarkdown("anything", targetStreamId, "msg_01JZZZZZZZZZZZZZZZZZZZZZZZ"))

      expect({ quotes: findQuotes(stored.contentJson), markdown: stored.contentMarkdown }).toEqual({
        quotes: [],
        markdown: "Context first.\n\nAfterwards.",
      })
    })
  })

  test("a quote that names the target stream but lives elsewhere is pinned to its real stream", async () => {
    await withTestTransaction(pool, async (client) => {
      const { source, sourceStreamId, targetStreamId, quoteMarkdown, sendAsAgent } = await seed(client)

      const stored = await sendAsAgent(quoteMarkdown("We ship it Friday", targetStreamId))

      expect(
        findQuotes(stored.contentJson).map(({ messageId, streamId, snippet }) => ({ messageId, streamId, snippet }))
      ).toEqual([{ messageId: source.id, streamId: sourceStreamId, snippet: SOURCE_TEXT }])
    })
  })

  test("a quote that names the target stream but lives out of scope is dropped and the prose ships", async () => {
    await withTestTransaction(pool, async (client) => {
      const { targetStreamId, quoteMarkdown, sendAsAgent } = await seed(client)

      const stored = await sendAsAgent(quoteMarkdown("We ship it Friday", targetStreamId), [targetStreamId])

      expect({ quotes: findQuotes(stored.contentJson), markdown: stored.contentMarkdown }).toEqual({
        quotes: [],
        markdown: "Context first.\n\nAfterwards.",
      })
    })
  })

  test("a user-authored paraphrased quote is still rejected", async () => {
    await withTestTransaction(pool, async (client) => {
      const { ws, actor, service, targetStreamId, quoteMarkdown } = await seed(client)
      const markdown = quoteMarkdown("We ship it Friday")

      expect(
        await refusal(
          service.createMessage({
            workspaceId: ws,
            streamId: targetStreamId,
            authorId: actor.id,
            authorType: "user",
            contentJson: parseMarkdown(markdown),
            contentMarkdown: markdown,
          })
        )
      ).toMatchObject({ code: MessageReferenceErrorCodes.RANGE_NOT_FOUND })
    })
  })
})
