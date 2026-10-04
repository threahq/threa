import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { AttachmentRepository, AttachmentUploadRepository } from "../../src/features/attachments"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { attachmentId, attachmentUploadId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

// The sweeps cover every workspace in a shared database: seeded rows sit in the year 2000 and the cutoff
// follows it, so no other test's rows qualify.
const LONG_AGO = new Date("2000-01-01T00:00:00Z")
const SWEEP_CUTOFF = new Date("2000-01-02T00:00:00Z")

interface AttachmentSeed {
  streamId?: string
  messageId?: string
  safetyStatus?: string
  createdAt?: Date
}

describe("Attachment sweeps and the unnest pair claim workspace scope (INV-8)", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let userA: { id: string; slug: string; name: string }

  async function insertRow(table: string, row: Record<string, unknown>) {
    const columns = Object.keys(row)
    await pool.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    )
  }

  async function rowsOf(table: string, column: string, value: string) {
    const result = await pool.query(`SELECT * FROM ${table} WHERE ${column} = $1`, [value])
    return result.rows
  }

  async function seedWorkspace(label: string) {
    const id = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id,
        name: `Attachments scope ${label}`,
        slug: `attachments-scope-${label}-${id}`,
        createdBy: userId(),
      })
    })
    return id
  }

  async function seedMember(wid: string) {
    return withTransaction(pool, async (client) => {
      const member = await addTestMember(client, wid, userId())
      return { id: member.id, slug: member.slug, name: member.name }
    })
  }

  async function addAttachment(wid: string, seed: AttachmentSeed = {}) {
    const id = attachmentId()
    await insertRow("attachments", {
      id,
      workspace_id: wid,
      stream_id: seed.streamId ?? null,
      message_id: seed.messageId ?? null,
      uploaded_by: null,
      filename: `${id}.png`,
      mime_type: "image/png",
      size_bytes: 10,
      storage_path: `scope/${id}`,
      processing_status: "pending",
      safety_status: seed.safetyStatus ?? "clean",
      created_at: seed.createdAt ?? new Date(),
    })
    return id
  }

  async function addUpload(wid: string, attachment: string, seed: { status?: string; updatedAt?: Date } = {}) {
    const id = attachmentUploadId()
    await insertRow("attachment_uploads", {
      id,
      workspace_id: wid,
      attachment_id: attachment,
      uploaded_by: userA.id,
      status: seed.status ?? "reserved",
      expected_size_bytes: 10,
      ...(seed.updatedAt ? { updated_at: seed.updatedAt } : {}),
    })
    return id
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = await seedWorkspace("a")
    wsB = await seedWorkspace("b")
    userA = await seedMember(wsA)
  })

  afterAll(async () => {
    await pool.end()
  })

  describe("AttachmentRepository writes", () => {
    test("should quarantine only the attachments whose workspace and id both match a ref", async () => {
      const own = await addAttachment(wsA, { safetyStatus: "pending_scan" })
      const foreign = await addAttachment(wsB, { safetyStatus: "pending_scan" })
      const mislabelled = await addAttachment(wsA, { safetyStatus: "pending_scan" })
      const foreignBefore = await rowsOf("attachments", "id", foreign)
      const mislabelledBefore = await rowsOf("attachments", "id", mislabelled)

      const flipped = await AttachmentRepository.quarantineStuckPendingScans(pool, [
        { workspaceId: wsA, attachmentId: own },
        { workspaceId: wsA, attachmentId: foreign },
        { workspaceId: wsB, attachmentId: mislabelled },
      ])

      expect({
        flipped,
        own: (await rowsOf("attachments", "id", own)).map((row) => [row.safety_status, row.processing_status]),
        foreign: await rowsOf("attachments", "id", foreign),
        mislabelled: await rowsOf("attachments", "id", mislabelled),
      }).toEqual({
        flipped: [{ workspaceId: wsA, attachmentId: own }],
        own: [["quarantined", "skipped"]],
        foreign: foreignBefore,
        mislabelled: mislabelledBefore,
      })
    })

    test("should quarantine a stale workspace A pending_scan attachment when only a workspace B upload row names its id", async () => {
      const stale = await addAttachment(wsA, { safetyStatus: "pending_scan", createdAt: LONG_AGO })
      await addUpload(wsB, stale)

      const quarantined = await AttachmentRepository.quarantineStalePendingScans(pool, {
        olderThan: SWEEP_CUTOFF,
        limit: 100,
      })

      expect({
        quarantined: quarantined.filter((id) => id === stale),
        stale: (await rowsOf("attachments", "id", stale)).map((row) => [row.safety_status, row.processing_status]),
      }).toEqual({ quarantined: [stale], stale: [["quarantined", "skipped"]] })
    })
  })

  describe("AttachmentUploadRepository", () => {
    test.each([
      [
        "failStale",
        "reserved" as const,
        "failed" as const,
        (olderThan: Date) => AttachmentUploadRepository.failStale(pool, { olderThan, limit: 100 }),
      ],
      [
        "abandonStaleFailed",
        "failed" as const,
        "abandoned" as const,
        (olderThan: Date) => AttachmentUploadRepository.abandonStaleFailed(pool, { olderThan, limit: 100 }),
      ],
      [
        "deleteStaleUploaded",
        "uploaded" as const,
        "uploaded" as const,
        (olderThan: Date) => AttachmentUploadRepository.deleteStaleUploaded(pool, { olderThan, limit: 100 }),
      ],
    ])(
      "should not report the bind state of a workspace B attachment when %s sweeps a workspace A upload row naming its id",
      async (_, seededStatus, sweptStatus, sweep) => {
        const foreignAttachment = await addAttachment(wsB, { streamId: streamId(), messageId: messageId() })
        await addUpload(wsA, foreignAttachment, { status: seededStatus, updatedAt: LONG_AGO })
        const foreignBefore = await rowsOf("attachments", "id", foreignAttachment)

        const swept = await sweep(SWEEP_CUTOFF)

        expect({
          swept: swept.filter((upload) => upload.attachmentId === foreignAttachment),
          foreignAttachment: await rowsOf("attachments", "id", foreignAttachment),
        }).toEqual({
          swept: [
            {
              attachmentId: foreignAttachment,
              workspaceId: wsA,
              status: sweptStatus,
              messageId: null,
              streamId: null,
              storagePath: null,
            },
          ],
          foreignAttachment: foreignBefore,
        })
      }
    )
  })
})
