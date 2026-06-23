import { describe, expect, it } from "bun:test"
import { AgentSessionRepository } from "./session-repository"
import type { Querier } from "../../db"

// Unit-level coverage of the client_step_id dedup control flow. The real
// partial-unique enforcement is a DB concern (integration); here we verify that
// appendStep, on a client_step_id collision, returns the existing row instead of
// looping or throwing — and only when a key was supplied.

interface FakeStepRow {
  id: string
  session_id: string
  step_number: number
  step_type: string
  content: unknown
  content_ciphertext: unknown
  content_envelope: unknown
  sources: unknown
  message_id: unknown
  tokens_used: unknown
  started_at: Date
  completed_at: Date | null
}

function stepRow(overrides: Partial<FakeStepRow>): FakeStepRow {
  return {
    id: "step_x",
    session_id: "sess_1",
    step_number: 1,
    step_type: "thinking",
    content: null,
    content_ciphertext: null,
    content_envelope: null,
    sources: null,
    message_id: null,
    tokens_used: null,
    started_at: new Date("2026-06-23T00:00:00Z"),
    completed_at: null,
    ...overrides,
  }
}

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error("duplicate key"), { code: "23505", constraint })
}

/** A Querier whose `query` returns/throws the queued responses in call order. */
function makeDb(responses: Array<{ rowCount?: number; rows: unknown[] } | Error>): Querier {
  let i = 0
  return {
    query: async () => {
      const next = responses[i++]
      if (next instanceof Error) throw next
      return next as never
    },
  } as unknown as Querier
}

const baseParams = { id: "step_new", sessionId: "sess_1", stepType: "thinking" as const, startedAt: new Date() }

describe("AgentSessionRepository.appendStep — client_step_id idempotency", () => {
  it("dedups a re-send under the same client_step_id to the row the first append created", async () => {
    const existing = stepRow({ id: "step_orig", step_number: 5 })
    const db = makeDb([
      { rowCount: 1, rows: [{}] }, // session existence check
      uniqueViolation("agent_session_steps_client_step_id_key"), // INSERT collides on the key
      { rows: [existing] }, // SELECT by (session_id, client_step_id)
    ])

    const result = await AgentSessionRepository.appendStep(db, { ...baseParams, clientStepId: "key-1" })

    expect(result.id).toBe("step_orig")
    expect(result.stepNumber).toBe(5)
  })

  it("returns the freshly inserted row on the happy path", async () => {
    const db = makeDb([{ rowCount: 1, rows: [{}] }, { rows: [stepRow({ id: "step_new", step_number: 2 })] }])

    const result = await AgentSessionRepository.appendStep(db, { ...baseParams, clientStepId: "key-1" })

    expect(result.id).toBe("step_new")
    expect(result.stepNumber).toBe(2)
  })

  it("rethrows a unique violation when no client_step_id was supplied (no dedup escape hatch)", async () => {
    const db = makeDb([{ rowCount: 1, rows: [{}] }, uniqueViolation("agent_session_steps_pkey")])

    await expect(AgentSessionRepository.appendStep(db, baseParams)).rejects.toThrow()
  })
})
