import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture, botRuntimeServiceFor } from "./setup"
import { StreamTypes, Visibilities } from "@threahq/types"
import { MessageRepository } from "../../src/features/messaging"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { messageId, streamId } from "../../src/lib/id"

describe("archiveOwnCommandThread", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string
  const service = () => botRuntimeServiceFor(pool)

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "done_archive", instanceIds: ["done-instance"] })
    ;({ pool, workspace, stream: root, author, bot } = fixture)
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  beforeEach(async () => {
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM messages WHERE stream_id = $1", [root])
    await pool.query("DELETE FROM streams WHERE workspace_id = $1 AND id <> $2", [workspace, root])
  })

  let sequence = 0n
  async function anchorMessage() {
    sequence += 1n
    return MessageRepository.insert(pool, {
      id: messageId(),
      streamId: root,
      sequence,
      authorId: author,
      authorType: "user",
      contentJson: testContentJson("anchor message"),
      contentMarkdown: "anchor message",
    })
  }

  async function botThread() {
    const anchor = await anchorMessage()
    const { stream } = await service().attachRuntimeSessionToThread({
      workspaceId: workspace,
      botId: bot,
      ownerUserId: author,
      runtimeKind: "pi-local",
      instanceId: "done-instance",
      runtimeSessionId: "done-session",
      rootStreamId: root,
      anchorId: anchor.id,
      displayName: "Sub work",
      traits: ["active-scratchpad"],
    })
    return stream.id
  }

  const archive = (streamIdToClose: string) =>
    service().archiveOwnCommandThread(pool, { workspaceId: workspace, botId: bot, streamId: streamIdToClose })

  test("archives the thread the bot opened once, leaving the root open", async () => {
    const thread = await botThread()

    expect({ first: await archive(thread), second: await archive(thread) }).toEqual({ first: thread, second: null })

    const [closed, rootStream] = await Promise.all([
      StreamRepository.findByIdForWorkspace(pool, thread, workspace),
      StreamRepository.findByIdForWorkspace(pool, root, workspace),
    ])
    expect({ thread: closed?.archivedAt !== null, root: rootStream?.archivedAt }).toEqual({ thread: true, root: null })
    const lifecycle = await StreamEventRepository.list(pool, thread, { types: ["stream_archived"] })
    expect(lifecycle).toMatchObject([{ eventType: "stream_archived", actorId: bot, actorType: "bot" }])
  })

  test("leaves a scratchpad and a thread the bot did not open alone", async () => {
    const anchor = await anchorMessage()
    const userThread = streamId()
    await StreamRepository.insert(pool, {
      id: userThread,
      workspaceId: workspace,
      type: StreamTypes.THREAD,
      visibility: Visibilities.PRIVATE,
      parentStreamId: root,
      parentAnchorId: anchor.id,
      rootStreamId: root,
      createdBy: author,
    })

    expect({ root: await archive(root), userThread: await archive(userThread) }).toEqual({
      root: null,
      userThread: null,
    })
    const open = await pool.query<{ archived_at: Date | null }>(
      "SELECT archived_at FROM streams WHERE id = ANY($1) ORDER BY id",
      [[root, userThread]]
    )
    expect(open.rows.map((row) => row.archived_at)).toEqual([null, null])
  })
})
