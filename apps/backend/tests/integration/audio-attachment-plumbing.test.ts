import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { ProcessingStatuses } from "@threahq/types"
import { setupTestDatabase, withTestTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { AttachmentRepository, toAttachmentSummary } from "../../src/features/attachments"
import { resolveAttachmentVariant } from "../../src/features/attachments/handlers"
import { EventService } from "../../src/features/messaging"
import type { MessageCreatedPayload } from "../../src/features/messaging"
import type { StreamEvent } from "../../src/features/streams"
import { userId, workspaceId, streamId, attachmentId, messageId, eventId } from "../../src/lib/id"

const WAVEFORM = Buffer.from(Array.from({ length: 200 }, (_, i) => i % 256)).toString("base64")

describe("audio attachment plumbing", () => {
  let pool: Pool
  let testUserId: string
  let testWorkspaceId: string
  let otherWorkspaceId: string
  let testStreamId: string

  beforeAll(async () => {
    pool = await setupTestDatabase()
    testUserId = userId()
    testWorkspaceId = workspaceId()
    otherWorkspaceId = workspaceId()
    testStreamId = streamId()

    await withTestTransaction(pool, async (client) => {
      for (const id of [testWorkspaceId, otherWorkspaceId]) {
        await WorkspaceRepository.insert(client, {
          id,
          name: "Audio Plumbing",
          slug: `audio-plumbing-${id}`,
          createdBy: testUserId,
        })
      }
      await addTestMember(client, testWorkspaceId, testUserId)
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

  async function insertAttachment(params: { filename: string; mimeType: string; workspace?: string }) {
    const id = attachmentId()
    const ws = params.workspace ?? testWorkspaceId
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: ws,
      streamId: ws === testWorkspaceId ? testStreamId : undefined,
      uploadedBy: testUserId,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: 4096,
      storagePath: `${ws}/${id}/${params.filename}`,
      processingStatus: ProcessingStatuses.PROCESSING,
    })
    return id
  }

  async function processedAudio(normalized: boolean) {
    const id = await insertAttachment({ filename: "memo.wav", mimeType: "audio/wav" })
    const landed = await AttachmentRepository.updateAudioResult(pool, testWorkspaceId, id, {
      normalizedAudioStoragePath: normalized ? `${testWorkspaceId}/${id}/normalized.m4a` : null,
      durationMs: 3210,
      waveform: WAVEFORM,
    })
    expect(landed).toBe(true)
    return (await AttachmentRepository.findById(pool, testWorkspaceId, id))!
  }

  test("summary carries the stored audio result", async () => {
    const row = await processedAudio(true)
    expect(toAttachmentSummary(row)).toEqual({
      id: row.id,
      filename: "memo.wav",
      mimeType: "audio/wav",
      sizeBytes: 4096,
      safetyStatus: "pending_scan",
      audio: { status: "completed", durationMs: 3210, waveform: WAVEFORM, normalized: true },
    })
  })

  test("summary of an upload served as is does not claim a normalized copy", async () => {
    const row = await processedAudio(false)
    expect(toAttachmentSummary(row).audio).toEqual({ status: "completed", durationMs: 3210, waveform: WAVEFORM })
  })

  test("non-audio rows carry no audio key", async () => {
    const id = await insertAttachment({ filename: "notes.pdf", mimeType: "application/pdf" })
    const row = (await AttachmentRepository.findById(pool, testWorkspaceId, id))!
    expect("audio" in toAttachmentSummary(row)).toBe(false)
  })

  test("bootstrap overlay replaces a stale audio snapshot with the fresh row", async () => {
    const row = await processedAudio(true)
    const msgId = messageId()
    const event = {
      id: eventId(),
      streamId: testStreamId,
      sequence: "1",
      eventType: "message_created",
      payload: {
        messageId: msgId,
        attachments: [
          { id: row.id, filename: row.filename, mimeType: row.mimeType, sizeBytes: 4096, audio: { status: "pending" } },
        ],
      },
      actorId: testUserId,
      actorType: "user",
      createdAt: new Date(),
    } as unknown as StreamEvent

    const [enriched] = await new EventService(pool).enrichBootstrapEvents([event], new Map(), new Map(), {
      workspaceId: testWorkspaceId,
      streamId: testStreamId,
    })
    expect((enriched.payload as MessageCreatedPayload).attachments).toEqual([
      {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: 4096,
        audio: { status: "completed", durationMs: 3210, waveform: WAVEFORM, normalized: true },
      },
    ])
  })

  test("processed variant resolves to the normalized object, raw on passthrough, not ready while processing", async () => {
    const normalized = await processedAudio(true)
    const passthrough = await processedAudio(false)
    const pendingId = await insertAttachment({ filename: "late.mp3", mimeType: "audio/mpeg" })
    const pending = (await AttachmentRepository.findById(pool, testWorkspaceId, pendingId))!

    expect(
      await Promise.all(
        [normalized, passthrough, pending].map((a) => resolveAttachmentVariant(pool, testWorkspaceId, a, "processed"))
      )
    ).toEqual([
      {
        storagePath: `${testWorkspaceId}/${normalized.id}/normalized.m4a`,
        contentType: "audio/mp4",
        filename: "memo.m4a",
        ready: true,
      },
      { storagePath: passthrough.storagePath, contentType: "audio/wav", filename: "memo.wav", ready: true },
      { storagePath: pending.storagePath, contentType: "audio/mpeg", filename: "late.mp3", ready: false },
    ])
  })

  test("updateAudioResult lands only while processing and only in its workspace", async () => {
    const completedId = await insertAttachment({ filename: "a.wav", mimeType: "audio/wav" })
    await AttachmentRepository.updateProcessingStatus(pool, testWorkspaceId, completedId, ProcessingStatuses.COMPLETED)
    const foreignId = await insertAttachment({ filename: "b.wav", mimeType: "audio/wav", workspace: otherWorkspaceId })
    const result = { normalizedAudioStoragePath: null, durationMs: 1, waveform: WAVEFORM }

    const landed = [
      await AttachmentRepository.updateAudioResult(pool, testWorkspaceId, completedId, result),
      await AttachmentRepository.updateAudioResult(pool, testWorkspaceId, foreignId, result),
    ]
    const rows = [
      await AttachmentRepository.findById(pool, testWorkspaceId, completedId),
      await AttachmentRepository.findById(pool, otherWorkspaceId, foreignId),
    ]
    expect({
      landed,
      rows: rows.map((r) => ({ status: r!.processingStatus, durationMs: r!.durationMs, waveform: r!.waveform })),
    }).toEqual({
      landed: [false, false],
      rows: [
        { status: "completed", durationMs: null, waveform: null },
        { status: "processing", durationMs: null, waveform: null },
      ],
    })
  })
})
