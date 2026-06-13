import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import {
  ENCLAVE_CLAIM_MAX_ATTEMPTS,
  ENCLAVE_CLAIM_TTL_SECONDS,
  ENCLAVE_PENDING_PARK_AFTER_MS,
  EnclaveInvocationsRepository,
} from "./invocations-repository"

const NOW = new Date("2026-06-12T12:00:00.000Z")

// A complete row so `mapRow` (which asserts a known status) doesn't throw.
// These tests assert on the SQL the repo builds, not on the round-trip.
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "einv_1",
    workspace_id: "ws_1",
    stream_id: "stream_1",
    root_stream_id: "stream_1",
    message_id: "msg_trigger",
    triggered_by: "usr_kris",
    status: "claimed",
    claimed_by_key_id: "eik_live",
    claim_token: "cbtok_1",
    claim_expires_at: NOW,
    session_id: null,
    attempts: 1,
    error_message: null,
    created_at: NOW,
    updated_at: NOW,
    completed_at: null,
    ...overrides,
  }
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

const INSERT_PARAMS = {
  id: "einv_1",
  workspaceId: "ws_1",
  streamId: "stream_1",
  rootStreamId: "stream_1",
  messageId: "msg_trigger",
  triggeredBy: "usr_kris",
}

afterEach(() => mock.restore())

describe("EnclaveInvocationsRepository.insertPending", () => {
  it("is idempotent on the trigger — an existing row of any status wins (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0) // conflict → no row written

    const inserted = await EnclaveInvocationsRepository.insertPending(db, INSERT_PARAMS)

    expect(captured.text).toContain("INSERT INTO enclave_invocations")
    expect(captured.text).toContain("ON CONFLICT (workspace_id, message_id) DO NOTHING")
    expect(inserted).toBe(false)
  })
})

describe("EnclaveInvocationsRepository.insertOrReopen", () => {
  it("reopens only a terminal row — a live pending/claimed invocation is left untouched", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await EnclaveInvocationsRepository.insertOrReopen(db, INSERT_PARAMS)

    expect(captured.text).toContain("ON CONFLICT (workspace_id, message_id) DO UPDATE")
    // Fresh attempt budget + cleared claim/session state on reopen…
    expect(captured.text).toContain("status = 'pending'")
    expect(captured.text).toContain("attempts = 0")
    expect(captured.text).toContain("session_id = NULL")
    // …but only for rows that already finished — in-flight work is not reset.
    expect(captured.text).toContain("WHERE enclave_invocations.status IN ('completed', 'failed', 'parked')")
  })
})

describe("EnclaveInvocationsRepository.claimNext", () => {
  it("claims race-safely, bounded by attempts, only rows the EIK's wraps can actually serve", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow()])

    const claimed = await EnclaveInvocationsRepository.claimNext(db, {
      keyId: "eik_live",
      claimToken: "cbtok_1",
      claimTtlSeconds: ENCLAVE_CLAIM_TTL_SECONDS,
      maxAttempts: ENCLAVE_CLAIM_MAX_ATTEMPTS,
    })

    // Race-safe across concurrent pollers (INV-20).
    expect(captured.text).toContain("FOR UPDATE OF i SKIP LOCKED")
    // Pending, or claimed-and-lapsed; never an actively-held claim.
    expect(captured.text).toContain("i.status = 'pending' OR (i.status = 'claimed' AND i.claim_expires_at < NOW())")
    expect(captured.text).toContain("i.attempts <")
    // The wrap predicate: the claiming key must cover the reply's generation
    // (the stream's LIVE current_key_generation, never a snapshot)…
    expect(captured.text).toContain("w.key_generation = e.current_key_generation")
    // …and the prompt's (the trigger envelope's).
    expect(captured.text).toContain("(m.envelope ->> 'keyGeneration')::int")
    expect(captured.text).toContain("recipient_kind = 'enclave'")
    // Oldest first, attempts incremented, token + TTL stamped.
    expect(captured.text).toContain("ORDER BY i.created_at ASC, i.id ASC")
    expect(captured.text).toContain("attempts = attempts + 1")
    expect(captured.values).toContain("eik_live")
    expect(captured.values).toContain("cbtok_1")
    expect(claimed).toMatchObject({ id: "einv_1", status: "claimed", claimToken: "cbtok_1" })
  })

  it("returns null when nothing is claimable", async () => {
    const db = createQuerier({ text: null, values: null }, [])
    const claimed = await EnclaveInvocationsRepository.claimNext(db, {
      keyId: "eik_live",
      claimToken: "cbtok_1",
      claimTtlSeconds: 60,
      maxAttempts: 5,
    })
    expect(claimed).toBeNull()
  })
})

describe("EnclaveInvocationsRepository claim lifecycle by session", () => {
  it("completes only the live claim for the session", async () => {
    const captured: Captured = { text: null, values: null }
    await EnclaveInvocationsRepository.completeBySession(createQuerier(captured), "session_1")
    expect(captured.text).toContain("SET status = 'completed'")
    expect(captured.text).toContain("WHERE session_id = $")
    expect(captured.text).toContain("status = 'claimed'")
    expect(captured.values).toEqual(["session_1"])
  })

  it("fails the claim terminally with the error preserved", async () => {
    const captured: Captured = { text: null, values: null }
    await EnclaveInvocationsRepository.failBySession(createQuerier(captured), {
      sessionId: "session_1",
      errorMessage: "Enclave session failed: AbortError",
    })
    expect(captured.text).toContain("SET status = 'failed'")
    expect(captured.text).toContain("status = 'claimed'")
    expect(captured.values).toContain("Enclave session failed: AbortError")
  })

  it("renews only a still-live claim — an expired one may already be re-claimed elsewhere (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    await EnclaveInvocationsRepository.renewBySession(createQuerier(captured), {
      sessionId: "session_1",
      claimTtlSeconds: 60,
    })
    expect(captured.text).toContain("SET claim_expires_at = NOW() +")
    expect(captured.text).toContain("claim_expires_at > NOW()")
    expect(captured.text).toContain("status = 'claimed'")
  })
})

describe("EnclaveInvocationsRepository.parkExhausted", () => {
  it("dead-letters lapsed exhausted claims AND aged-out pending rows, preserving existing errors", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow({ status: "parked" })])

    const parked = await EnclaveInvocationsRepository.parkExhausted(db, {
      maxAttempts: ENCLAVE_CLAIM_MAX_ATTEMPTS,
      pendingMaxAgeMs: ENCLAVE_PENDING_PARK_AFTER_MS,
    })

    expect(captured.text).toContain("SET status = 'parked'")
    // A claim that kept lapsing with the budget spent…
    expect(captured.text).toContain("status = 'claimed' AND claim_expires_at < NOW() AND attempts >=")
    // …or a pending row nothing could ever claim in time.
    expect(captured.text).toContain("status = 'pending' AND created_at <")
    // Existing failure context wins over the generic explanation.
    expect(captured.text).toContain("COALESCE(error_message,")
    expect(parked).toHaveLength(1)
    expect(parked[0]!.status).toBe("parked")
  })
})
