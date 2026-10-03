import { DisabledAnalyticsReporter } from "@threahq/backend-common"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AgentStepTypes, MemoryModes, type StreamType, type Visibility } from "@threahq/types"
import { AgentSessionRepository, ReflectiveCaptureService, SessionStatuses } from "../../src/features/agents"
import { MemoService } from "../../src/features/memos"
import type { ConversationClassification } from "../../src/features/memos/classifier"
import { MessageRepository } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { messageId, personaId, sessionId, stepId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase, testMessageContent, withTransaction } from "./setup"

const worthy: ConversationClassification = {
  isKnowledgeWorthy: true,
  shouldReviseExisting: false,
  revisionReason: null,
  confidence: 0.9,
  containsActionItems: false,
}

let embedCalls = 0
function nextEmbedding(): number[] {
  const axis = embedCalls++
  return Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0))
}

describe("reflective capture: research sources", () => {
  let pool: Pool
  let testWorkspaceId: string
  let testUserId: string

  function captureService(): ReflectiveCaptureService {
    const memoService = new MemoService({
      analyticsReporter: new DisabledAnalyticsReporter(),
      pool,
      classifier: {
        classifyConversation: async () => worthy,
      },
      memorizer: {
        memorizeConversation: async () => [
          {
            title: "Deploys go through the release channel",
            abstract: "Production deploys are announced in the release channel first.",
            keyPoints: [],
            sourceMessageIds: [],
            knowledgeType: "learning",
            tags: [],
          },
        ],
      } as never,
      embeddingService: { embedBatch: async (texts: string[]) => texts.map(() => nextEmbedding()) } as never,
      messageFormatter: { formatMessages: async () => "" } as never,
    })
    return new ReflectiveCaptureService({ pool, memoService })
  }

  async function seedStream(
    params: { type: StreamType; visibility: Visibility } | { threadOf: string; anchorId: string }
  ): Promise<string> {
    const id = streamId()
    await StreamRepository.insert(pool, {
      id,
      workspaceId: testWorkspaceId,
      memoryMode: MemoryModes.AUTO,
      createdBy: testUserId,
      ...("threadOf" in params
        ? {
            type: "thread",
            visibility: "private",
            parentStreamId: params.threadOf,
            rootStreamId: params.threadOf,
            parentAnchorId: params.anchorId,
          }
        : params),
    })
    return id
  }

  async function seedMessage(stream: string): Promise<string> {
    const id = messageId()
    await MessageRepository.insert(pool, {
      workspaceId: testWorkspaceId,
      id,
      streamId: stream,
      sequence: BigInt(Date.now()),
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("where do production deploys get announced?"),
    })
    return id
  }

  /** A completed session in `stream` whose one research turn cited `cited` messages. */
  async function seedSession(
    stream: string,
    triggerMessageId: string,
    cited: { streamId: string; messageId: string }[]
  ): Promise<string> {
    const id = sessionId()
    await AgentSessionRepository.insert(pool, {
      workspaceId: testWorkspaceId,
      id,
      streamId: stream,
      personaId: personaId(),
      triggerMessageId,
      status: SessionStatuses.COMPLETED,
    })
    await AgentSessionRepository.upsertStep(pool, {
      id: stepId(),
      sessionId: id,
      stepNumber: 0,
      stepType: AgentStepTypes.TURN_DIGEST,
      content: {
        findings: "Deploys are announced in the release channel before they ship.",
        toolsCalled: ["search_messages"],
        sources: cited.map((c) => ({ type: "workspace_message", title: "cited", ...c })),
        sourceStreamIds: [...new Set(cited.map((c) => c.streamId))],
      },
      startedAt: new Date(),
    })
    return id
  }

  async function capturedMemos(session: string) {
    const { rows } = await pool.query(`SELECT scope, source_message_ids FROM memos WHERE source_session_id = $1`, [
      session,
    ])
    return rows.map((row) => ({ scope: row.scope, sourceMessageIds: row.source_message_ids }))
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testWorkspaceId = workspaceId()
    const workosUserId = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Reflective Capture Sources",
        slug: `reflective-capture-sources-${testWorkspaceId}`,
        createdBy: workosUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, workosUserId)).id
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a channel session whose research cites another channel captures, sourced only from its own root", async () => {
    const channel = await seedStream({ type: "channel", visibility: "public" })
    const other = await seedStream({ type: "channel", visibility: "private" })
    const trigger = await seedMessage(channel)
    const session = await seedSession(channel, trigger, [{ streamId: other, messageId: await seedMessage(other) }])

    await captureService().capture({ workspaceId: testWorkspaceId, sessionId: session })

    expect(await capturedMemos(session)).toEqual([{ scope: "workspace", sourceMessageIds: [trigger] }])
  })

  test("a private scratchpad session whose research cites a channel still captures into its owner's tier", async () => {
    const scratchpad = await seedStream({ type: "scratchpad", visibility: "private" })
    const channel = await seedStream({ type: "channel", visibility: "private" })
    const trigger = await seedMessage(scratchpad)
    const session = await seedSession(scratchpad, trigger, [
      { streamId: channel, messageId: await seedMessage(channel) },
    ])

    await captureService().capture({ workspaceId: testWorkspaceId, sessionId: session })

    expect(await capturedMemos(session)).toEqual([{ scope: "user", sourceMessageIds: [trigger] }])
  })

  test("research cited from the session's own channel lands in the memo's sources", async () => {
    const channel = await seedStream({ type: "channel", visibility: "public" })
    const trigger = await seedMessage(channel)
    const thread = await seedStream({ threadOf: channel, anchorId: trigger })
    const threadReply = await seedMessage(thread)
    const session = await seedSession(channel, trigger, [{ streamId: thread, messageId: threadReply }])

    await captureService().capture({ workspaceId: testWorkspaceId, sessionId: session })

    expect(await capturedMemos(session)).toEqual([{ scope: "workspace", sourceMessageIds: [trigger, threadReply] }])
  })

  test("the capture is placed at the session's anchor, not at its cited research", async () => {
    const channel = await seedStream({ type: "channel", visibility: "public" })
    const trigger = await seedMessage(channel)
    const thread = await seedStream({ threadOf: channel, anchorId: trigger })
    const threadReply = await seedMessage(thread)
    const session = await seedSession(channel, trigger, [{ streamId: thread, messageId: threadReply }])

    await captureService().capture({ workspaceId: testWorkspaceId, sessionId: session })

    const { rows: events } = await pool.query(
      `SELECT payload FROM stream_events WHERE stream_id = $1 AND event_type = 'memos:captured'`,
      [channel]
    )
    const { rows: landmarks } = await pool.query(
      `SELECT i.source_message_id, i.sequence = m.sequence AS at_anchor
       FROM stream_context_items i
       JOIN memos memo ON memo.id = i.ref_id
       JOIN messages m ON m.id = $2
       WHERE memo.source_session_id = $1`,
      [session, trigger]
    )
    expect({
      eventSources: events.flatMap((e) =>
        e.payload.memos.map((m: { sourceMessageIds: string[] }) => m.sourceMessageIds)
      ),
      landmarks,
    }).toEqual({
      eventSources: [[trigger]],
      landmarks: [{ source_message_id: trigger, at_anchor: true }],
    })
  })
})
