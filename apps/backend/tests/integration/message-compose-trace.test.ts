import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase, withTransaction, addTestMember, testMessageContent } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { EventService, type GetComposeTraceMode } from "../../src/features/messaging"
import { MessageComposeTraceRepository } from "../../src/features/messaging"
import { userId, workspaceId, streamId, messageId } from "../../src/lib/id"

const trace = {
  horizonStreamId: "stream_horizon",
  openedAt: "2026-07-30T10:00:00.000Z",
  openedAtSequence: 41,
  sentAtSequence: 47,
  resumedDraft: true,
}

describe("Compose-trace capture", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let testStreamId: string

  const capturing: GetComposeTraceMode = async () => "capture"
  const off: GetComposeTraceMode = async () => "off"

  beforeAll(async () => {
    pool = await setupTestDatabase()

    testUserId = userId()
    testWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: testWorkspaceId,
        name: "Test Workspace",
        slug: `test-ws-${testWorkspaceId}`,
        createdBy: testUserId,
      })
      testUserId = (await addTestMember(client, testWorkspaceId, testUserId)).id
      await StreamRepository.insert(client, {
        id: testStreamId,
        workspaceId: testWorkspaceId,
        type: "scratchpad",
        visibility: "private",
        companionMode: "off",
        createdBy: testUserId,
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  function send(service: EventService, extra: Record<string, unknown>) {
    return service.createMessage({
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      authorId: testUserId,
      authorType: "user",
      ...testMessageContent("traced send"),
      ...extra,
    })
  }

  test("flag capture + trace persists the session as sent", async () => {
    const message = await send(new EventService(pool, undefined, capturing), { composeTrace: trace })

    const stored = await MessageComposeTraceRepository.findByMessageId(pool, testWorkspaceId, message.id)
    expect(stored).toEqual({
      messageId: message.id,
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      horizonStreamId: "stream_horizon",
      openedAt: new Date(trace.openedAt),
      // BIGINT crosses the driver as a string; the sidecar keeps it lossless.
      openedAtSequence: "41",
      sentAtSequence: "47",
      resumedDraft: true,
      createdAt: stored!.createdAt,
    })
  })

  test("null sequences are stored as null, not zero", async () => {
    const message = await send(new EventService(pool, undefined, capturing), {
      composeTrace: { ...trace, openedAtSequence: null, sentAtSequence: null, resumedDraft: false },
    })

    const stored = await MessageComposeTraceRepository.findByMessageId(pool, testWorkspaceId, message.id)
    expect({
      openedAtSequence: stored?.openedAtSequence,
      sentAtSequence: stored?.sentAtSequence,
      resumedDraft: stored?.resumedDraft,
    }).toEqual({ openedAtSequence: null, sentAtSequence: null, resumedDraft: false })
  })

  test("a second insert for the same message is a silent no-op", async () => {
    const id = messageId()
    await MessageComposeTraceRepository.insert(pool, {
      messageId: id,
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      horizonStreamId: "stream_horizon",
      openedAt: trace.openedAt,
      openedAtSequence: 1,
      sentAtSequence: 2,
      resumedDraft: false,
    })
    await MessageComposeTraceRepository.insert(pool, {
      messageId: id,
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
      horizonStreamId: "stream_horizon",
      openedAt: "2026-07-30T11:00:00.000Z",
      openedAtSequence: 9,
      sentAtSequence: 9,
      resumedDraft: true,
    })

    const stored = await MessageComposeTraceRepository.findByMessageId(pool, testWorkspaceId, id)
    expect({ openedAtSequence: stored?.openedAtSequence, resumedDraft: stored?.resumedDraft }).toEqual({
      openedAtSequence: "1",
      resumedDraft: false,
    })
  })

  test("the horizon stream is stored independently of the destination stream", async () => {
    const message = await send(new EventService(pool, undefined, capturing), {
      composeTrace: { ...trace, horizonStreamId: "stream_elsewhere" },
    })

    const stored = await MessageComposeTraceRepository.findByMessageId(pool, testWorkspaceId, message.id)
    expect({ streamId: stored?.streamId, horizonStreamId: stored?.horizonStreamId }).toEqual({
      streamId: testStreamId,
      horizonStreamId: "stream_elsewhere",
    })
  })

  test("flag off drops the trace instead of storing it", async () => {
    const message = await send(new EventService(pool, undefined, off), { composeTrace: trace })

    expect(await MessageComposeTraceRepository.findByMessageId(pool, testWorkspaceId, message.id)).toBeNull()
  })

  test("no trace on the send writes no row", async () => {
    const message = await send(new EventService(pool, undefined, capturing), {})

    expect(await MessageComposeTraceRepository.findByMessageId(pool, testWorkspaceId, message.id)).toBeNull()
  })

  test("a trace is not readable from another workspace", async () => {
    const message = await send(new EventService(pool, undefined, capturing), { composeTrace: trace })

    expect(await MessageComposeTraceRepository.findByMessageId(pool, workspaceId(), message.id)).toBeNull()
  })
})
