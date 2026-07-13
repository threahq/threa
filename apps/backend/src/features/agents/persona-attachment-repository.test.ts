import { describe, expect, test } from "bun:test"
import { PersonaAttachmentRepository } from "./persona-attachment-repository"

interface CapturedQuery {
  text: string
  values: unknown[]
}

/**
 * Fake Querier that records each query's SQL text + values and returns the next
 * queued rowset. Mirrors the persona-repository test harness.
 */
function createDb(rowsByQuery: unknown[][]) {
  const queries: CapturedQuery[] = []
  return {
    queries,
    query: async (query: { text: string; values: unknown[] }) => {
      queries.push({ text: query.text, values: query.values })
      const rows = rowsByQuery.shift() ?? []
      return { rows, rowCount: rows.length }
    },
  } as any
}

describe("PersonaAttachmentRepository.insertBinding", () => {
  test("takes a per-persona advisory lock, then a count-guarded insert that computes the next position", async () => {
    const db = createDb([
      [], // advisory lock
      [
        {
          attachment_id: "att_1",
          workspace_id: "workspace_1",
          persona_id: "persona_1",
          position: 2,
          created_by: "usr_1",
          created_at: new Date("2026-07-13T00:00:00Z"),
        },
      ],
    ])

    const binding = await PersonaAttachmentRepository.insertBinding(db, {
      attachmentId: "att_1",
      workspaceId: "workspace_1",
      personaId: "persona_1",
      createdBy: "usr_1",
      maxCount: 5,
    })

    // Advisory lock keyed on (workspace, persona) so the count guard runs serially.
    expect(db.queries[0]!.text).toContain("pg_advisory_xact_lock")
    // Race-safe cap: a single INSERT ... SELECT ... WHERE (SELECT count(*) ...) < cap.
    const insert = db.queries[1]!.text
    expect(insert).toContain("INSERT INTO persona_attachments")
    expect(insert).toContain("SELECT count(*) FROM persona_attachments")
    expect(insert).toMatch(/< \$\d+/)
    expect(insert).toContain("COALESCE(MAX(position), -1) + 1")
    expect(insert).toContain("RETURNING")
    expect(db.queries[1]!.values).toContain(5)
    expect(binding).toMatchObject({ attachmentId: "att_1", position: 2 })
  })

  test("returns null when the cap guard writes no row (persona already at cap)", async () => {
    const db = createDb([[], []]) // lock, then insert writes 0 rows

    const binding = await PersonaAttachmentRepository.insertBinding(db, {
      attachmentId: "att_1",
      workspaceId: "workspace_1",
      personaId: "persona_1",
      createdBy: "usr_1",
      maxCount: 5,
    })

    expect(binding).toBeNull()
  })
})

describe("PersonaAttachmentRepository.listForPersona", () => {
  test("joins attachments + extractions in one query, ordered by position, workspace-scoped", async () => {
    const db = createDb([
      [
        {
          attachment_id: "att_1",
          filename: "notes.txt",
          mime_type: "text/plain",
          size_bytes: "42",
          position: 0,
          created_at: new Date("2026-07-13T00:00:00Z"),
          processing_status: "completed",
          has_extraction: true,
          has_summary: true,
        },
      ],
    ])

    const items = await PersonaAttachmentRepository.listForPersona(db, "workspace_1", "persona_1")

    const text = db.queries[0]!.text
    expect(text).toContain("FROM persona_attachments pa")
    expect(text).toContain("JOIN attachments a")
    expect(text).toContain("LEFT JOIN attachment_extractions e")
    expect(text).toContain("ORDER BY pa.position ASC")
    expect(text).toContain("pa.workspace_id =")
    // One round trip (INV-56).
    expect(db.queries).toHaveLength(1)
    expect(items[0]).toEqual({
      attachmentId: "att_1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 42,
      position: 0,
      createdAt: new Date("2026-07-13T00:00:00Z"),
      processingStatus: "completed",
      hasExtraction: true,
      hasSummary: true,
    })
  })
})

describe("PersonaAttachmentRepository.deleteBinding", () => {
  test("deletes only the workspace+persona+attachment row and reports whether one was removed", async () => {
    const db = createDb([[{}]]) // rowCount 1

    const removed = await PersonaAttachmentRepository.deleteBinding(db, "workspace_1", "persona_1", "att_1")

    const text = db.queries[0]!.text
    expect(text).toContain("DELETE FROM persona_attachments")
    expect(text).toContain("workspace_id =")
    expect(text).toContain("persona_id =")
    expect(text).toContain("attachment_id =")
    expect(db.queries[0]!.values).toEqual(["workspace_1", "persona_1", "att_1"])
    expect(removed).toBe(true)
  })

  test("returns false when no binding matched", async () => {
    const db = createDb([[]]) // rowCount 0
    const removed = await PersonaAttachmentRepository.deleteBinding(db, "workspace_1", "persona_1", "missing")
    expect(removed).toBe(false)
  })
})
