import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { PERSONA_ATTACHMENT_MAX_COUNT, StreamTypes } from "@threa/types"
import { sql } from "../../src/db"
import { attachmentId, extractionId, personaId, workspaceId as newWorkspaceId, userId } from "../../src/lib/id"
import { PersonaAttachmentRepository } from "../../src/features/agents/persona-attachment-repository"
import { buildSystemPrompt } from "../../src/features/agents/companion/prompt/system-prompt"
import type { Persona } from "../../src/features/agents/persona-repository"
import type { StreamContext } from "../../src/features/agents/context-builder"
import { setupTestDatabase, withTestTransaction } from "./setup"

/**
 * End-to-end proof of the persona-context-attachments prompt path against a real
 * database (not the mocked block fixtures in system-prompt.test.ts): seed the
 * three real rows a persona file produces — the `attachments` row, the
 * `persona_attachments` binding (via the real cap-guarded insert), and the
 * `attachment_extractions` row with known text — then read them back through the
 * real join (`listForPersonaWithContent`) and compose the actual system prompt.
 * The `## Knowledge` block must carry the filename and the extracted full text.
 */

const persona: Persona = {
  id: "persona_test",
  workspaceId: "ws_test",
  slug: "custom-helper",
  name: "Custom Helper",
  description: null,
  avatarEmoji: null,
  avatarUrl: null,
  systemPrompt: "Base system prompt",
  model: "openai/gpt-5.4",
  escalationModel: null,
  temperature: 0.2,
  maxTokens: 1000,
  enabledTools: null,
  tonePreset: null,
  brevityPreset: null,
  tonePrompt: null,
  brevityPrompt: null,
  managedBy: "workspace",
  ownerUserId: null,
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
}

const scratchpadContext: StreamContext = {
  streamType: StreamTypes.SCRATCHPAD,
  streamInfo: { id: "stream_test", name: "Ideas", description: null, slug: null },
  conversationHistory: [],
}

let pool: Pool

beforeAll(async () => {
  pool = await setupTestDatabase()
})

afterAll(async () => {
  await pool.end()
})

describe("persona context attachments → dispatch prompt (integration)", () => {
  test("the real join feeds the ## Knowledge block with the filename and extracted full text", async () => {
    await withTestTransaction(pool, async (client) => {
      const workspaceId = newWorkspaceId()
      const personaRowId = personaId()
      const creator = userId()

      // Two persona files: one with extracted full text, one still pending (no
      // extraction row) so the block's degrade-to-processing path is exercised.
      const runbookId = attachmentId()
      const pendingId = attachmentId()
      const runbookText = "STEP 1: rotate the key. STEP 2: redeploy. STEP 3: verify the health check."

      for (const [id, filename] of [
        [runbookId, "runbook.md"],
        [pendingId, "draft-notes.txt"],
      ] as const) {
        await client.query(sql`
          INSERT INTO attachments (
            id, workspace_id, stream_id, message_id, filename, mime_type, size_bytes,
            storage_provider, storage_path, processing_status, uploaded_by
          ) VALUES (
            ${id}, ${workspaceId}, NULL, NULL, ${filename}, 'text/markdown', 512,
            's3', ${`personas/${personaRowId}/${id}`}, 'completed', ${creator}
          )
        `)
      }

      // Bind both through the real cap-guarded insert (advisory lock + position).
      const bindRunbook = await PersonaAttachmentRepository.insertBinding(client, {
        attachmentId: runbookId,
        workspaceId,
        personaId: personaRowId,
        createdBy: creator,
        maxCount: PERSONA_ATTACHMENT_MAX_COUNT,
      })
      expect(bindRunbook).not.toBeNull()
      expect(bindRunbook!.position).toBe(0)

      const bindPending = await PersonaAttachmentRepository.insertBinding(client, {
        attachmentId: pendingId,
        workspaceId,
        personaId: personaRowId,
        createdBy: creator,
        maxCount: PERSONA_ATTACHMENT_MAX_COUNT,
      })
      expect(bindPending!.position).toBe(1)

      // Extraction landed only for the runbook.
      await client.query(sql`
        INSERT INTO attachment_extractions (id, attachment_id, workspace_id, content_type, summary, full_text)
        VALUES (${extractionId()}, ${runbookId}, ${workspaceId}, 'document', 'A short runbook.', ${runbookText})
      `)

      // Read back through the REAL join and compose the REAL system prompt.
      const knowledge = await PersonaAttachmentRepository.listForPersonaWithContent(client, workspaceId, personaRowId)
      expect(knowledge.map((k) => k.filename)).toEqual(["runbook.md", "draft-notes.txt"])
      expect(knowledge[0]!.fullText).toBe(runbookText)

      const prompt = buildSystemPrompt(
        persona,
        scratchpadContext,
        null,
        undefined,
        undefined,
        null,
        [],
        null,
        null,
        null,
        null,
        null,
        undefined,
        knowledge
      )

      expect(prompt).toContain("## Knowledge")
      expect(prompt).toContain("### runbook.md")
      expect(prompt).toContain(runbookText)
      // The pending file still renders its heading and a processing note (never
      // silently dropped, INV-11 spirit).
      expect(prompt).toContain("### draft-notes.txt")
      expect(prompt).toContain("(processing — content not yet available)")
      // Position order: the runbook precedes the pending file.
      expect(prompt.indexOf("### runbook.md")).toBeLessThan(prompt.indexOf("### draft-notes.txt"))
      // Sits in the stable prefix — after the base persona prompt, before context.
      expect(prompt.indexOf("Base system prompt")).toBeLessThan(prompt.indexOf("## Knowledge"))
      expect(prompt.indexOf("## Knowledge")).toBeLessThan(prompt.indexOf("## Context"))
    })
  })

  test("workspace scoping: a foreign workspace id reads no attachments (byte-identical prompt)", async () => {
    await withTestTransaction(pool, async (client) => {
      const workspaceId = newWorkspaceId()
      const otherWorkspaceId = newWorkspaceId()
      const personaRowId = personaId()
      const creator = userId()
      const id = attachmentId()

      await client.query(sql`
        INSERT INTO attachments (
          id, workspace_id, stream_id, message_id, filename, mime_type, size_bytes,
          storage_provider, storage_path, processing_status, uploaded_by
        ) VALUES (
          ${id}, ${workspaceId}, NULL, NULL, 'secret.md', 'text/markdown', 128,
          's3', ${`personas/${personaRowId}/${id}`}, 'completed', ${creator}
        )
      `)
      await PersonaAttachmentRepository.insertBinding(client, {
        attachmentId: id,
        workspaceId,
        personaId: personaRowId,
        createdBy: creator,
        maxCount: PERSONA_ATTACHMENT_MAX_COUNT,
      })

      // Same persona id, wrong workspace → no rows (INV-8), and the composed
      // prompt is byte-identical to the attachment-less baseline.
      const leaked = await PersonaAttachmentRepository.listForPersonaWithContent(client, otherWorkspaceId, personaRowId)
      expect(leaked).toEqual([])

      const base = buildSystemPrompt(persona, scratchpadContext, null, undefined, undefined, null, [])
      const withForeign = buildSystemPrompt(
        persona,
        scratchpadContext,
        null,
        undefined,
        undefined,
        null,
        [],
        null,
        null,
        null,
        null,
        null,
        undefined,
        leaked
      )
      expect(withForeign).toBe(base)
      expect(base).not.toContain("## Knowledge")
    })
  })
})
