/**
 * Sealed rolling-summary integration tests.
 *
 * Exercises the runtime path unit tests can't: the additive sealed columns on
 * `agent_conversation_summaries`, the BYTEA + JSONB binding, base64 surfacing on
 * read, and the monotonic-cursor guard moving every representation column
 * together — end-to-end against a real Postgres. The plaintext companion shape
 * and the enclave sealed shape share one (stream, persona) row.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { ConversationSummaryRepository } from "../../src/features/agents"
import { agentConversationSummaryId, workspaceId, streamId } from "../../src/lib/id"

const PERSONA_ID = "persona_ariadne"
const ENVELOPE = { v: 2, keyGeneration: 3, iv: "aXYxMjM0NTY3OA==", aad: "c3VtbWFyeXwz" }

describe("ConversationSummaryRepository sealed rolling summary", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("plaintext row round-trips with a null sealed payload", async () => {
    const wsId = workspaceId()
    const sId = streamId()

    const stored = await ConversationSummaryRepository.upsert(pool, {
      id: agentConversationSummaryId(),
      workspaceId: wsId,
      streamId: sId,
      personaId: PERSONA_ID,
      summary: "Decided to ship C-2c; open question on the byte budget.",
      lastSummarizedSequence: 10n,
    })

    expect(stored).toEqual({
      id: stored.id,
      workspaceId: wsId,
      streamId: sId,
      personaId: PERSONA_ID,
      summary: "Decided to ship C-2c; open question on the byte budget.",
      sealed: null,
      lastSummarizedSequence: 10n,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    })
  })

  test("sealed row round-trips ciphertext (base64), envelope, and generation with a null plaintext", async () => {
    const wsId = workspaceId()
    const sId = streamId()
    const ciphertext = Buffer.from("sealed-rolling-summary-ciphertext").toString("base64")

    await ConversationSummaryRepository.upsert(pool, {
      id: agentConversationSummaryId(),
      workspaceId: wsId,
      streamId: sId,
      personaId: PERSONA_ID,
      sealed: { ciphertext, envelope: ENVELOPE, keyGeneration: 3 },
      lastSummarizedSequence: 5n,
    })

    const read = await ConversationSummaryRepository.findByStreamAndPersona(pool, sId, PERSONA_ID)
    expect(read?.summary).toBeNull()
    expect(read?.sealed).toEqual({ ciphertext, envelope: ENVELOPE, keyGeneration: 3 })
    expect(read?.lastSummarizedSequence).toBe(5n)
  })

  test("the monotonic cursor gates updates and moves every representation column together", async () => {
    const wsId = workspaceId()
    const sId = streamId()
    const recordId = agentConversationSummaryId()
    const firstCiphertext = Buffer.from("first-sealed").toString("base64")

    await ConversationSummaryRepository.upsert(pool, {
      id: recordId,
      workspaceId: wsId,
      streamId: sId,
      personaId: PERSONA_ID,
      sealed: { ciphertext: firstCiphertext, envelope: ENVELOPE, keyGeneration: 3 },
      lastSummarizedSequence: 5n,
    })

    // A lower sequence is a stale write — it must not overwrite the stored summary.
    await ConversationSummaryRepository.upsert(pool, {
      id: recordId,
      workspaceId: wsId,
      streamId: sId,
      personaId: PERSONA_ID,
      sealed: { ciphertext: Buffer.from("stale").toString("base64"), envelope: ENVELOPE, keyGeneration: 3 },
      lastSummarizedSequence: 4n,
    })

    const afterStale = await ConversationSummaryRepository.findByStreamAndPersona(pool, sId, PERSONA_ID)
    expect(afterStale?.sealed?.ciphertext).toBe(firstCiphertext)
    expect(afterStale?.lastSummarizedSequence).toBe(5n)

    // A higher sequence advances. Flipping to a plaintext representation clears
    // the sealed columns so a row never carries both at once.
    await ConversationSummaryRepository.upsert(pool, {
      id: recordId,
      workspaceId: wsId,
      streamId: sId,
      personaId: PERSONA_ID,
      summary: "Newer plaintext summary",
      lastSummarizedSequence: 9n,
    })

    const afterAdvance = await ConversationSummaryRepository.findByStreamAndPersona(pool, sId, PERSONA_ID)
    expect(afterAdvance?.summary).toBe("Newer plaintext summary")
    expect(afterAdvance?.sealed).toBeNull()
    expect(afterAdvance?.lastSummarizedSequence).toBe(9n)
  })
})
