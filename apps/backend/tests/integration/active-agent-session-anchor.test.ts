import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { AgentSessionRepository, SessionStatuses } from "../../src/features/agents"
import { streamId, userId, workspaceId, sessionId, personaId, messageId } from "../../src/lib/id"
import { AgentStepTypes } from "@threahq/types"

describe("listRunningByWorkspace anchors", () => {
  let pool: Pool

  const workspace = workspaceId()
  const otherWorkspace = workspaceId()
  const author = userId()
  const persona = personaId()

  const rootStream = streamId()
  const threadStream = streamId()
  const otherWorkspaceStream = streamId()

  const threadAnchor = messageId()
  const rootTrigger = messageId()
  const threadTrigger = messageId()

  const rootSession = sessionId()
  const threadSession = sessionId()
  const otherWorkspaceSession = sessionId()

  beforeAll(async () => {
    pool = await setupTestDatabase()

    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)",
      [rootStream, workspace, author]
    )
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, parent_stream_id, parent_anchor_id, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4, $5, $4)`,
      [threadStream, workspace, author, rootStream, threadAnchor]
    )
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)",
      [otherWorkspaceStream, otherWorkspace, author]
    )

    await AgentSessionRepository.insert(pool, {
      id: rootSession,
      streamId: rootStream,
      personaId: persona,
      triggerMessageId: rootTrigger,
      status: SessionStatuses.RUNNING,
      serverId: "test-server",
    })
    await AgentSessionRepository.insert(pool, {
      id: threadSession,
      streamId: threadStream,
      personaId: persona,
      triggerMessageId: threadTrigger,
      status: SessionStatuses.RUNNING,
      serverId: "test-server",
    })
    await AgentSessionRepository.insert(pool, {
      id: otherWorkspaceSession,
      streamId: otherWorkspaceStream,
      personaId: persona,
      triggerMessageId: messageId(),
      status: SessionStatuses.RUNNING,
      serverId: "test-server",
    })
    await AgentSessionRepository.updateCurrentStepType(pool, threadSession, AgentStepTypes.THINKING)
  })

  afterAll(async () => {
    await pool.end()
  })

  test("a thread session resolves to its anchor, its root and its trigger", async () => {
    const rows = await AgentSessionRepository.listRunningByWorkspace(pool, workspace)

    expect(rows.find((row) => row.sessionId === threadSession)).toEqual({
      sessionId: threadSession,
      streamId: threadStream,
      rootStreamId: rootStream,
      parentAnchorId: threadAnchor,
      triggerMessageId: threadTrigger,
      personaId: persona,
      startedAt: expect.any(Date),
      currentStepType: AgentStepTypes.THINKING,
    })
  })

  test("a root-stream session has no anchor and is its own root", async () => {
    const rows = await AgentSessionRepository.listRunningByWorkspace(pool, workspace)

    expect(rows.find((row) => row.sessionId === rootSession)).toEqual({
      sessionId: rootSession,
      streamId: rootStream,
      rootStreamId: rootStream,
      parentAnchorId: null,
      triggerMessageId: rootTrigger,
      personaId: persona,
      startedAt: expect.any(Date),
      currentStepType: null,
    })
  })

  test("a running session in another workspace is not returned", async () => {
    const rows = await AgentSessionRepository.listRunningByWorkspace(pool, workspace)

    expect(rows.map((row) => row.sessionId).sort()).toEqual([rootSession, threadSession].sort())
  })
})
