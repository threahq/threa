import { describe, it, expect } from "bun:test"
import { decideSettlement, PUSH_MAX_ATTEMPTS, type ProviderAttemptResult } from "./retry-policy"

const NOW = Date.parse("2026-09-28T12:00:00.000Z")
const DAY_LATER = new Date(NOW + 24 * 60 * 60 * 1000)

function result(overrides: Partial<ProviderAttemptResult>): ProviderAttemptResult {
  return { outcome: "unreachable", statusCode: 503, errorCode: null, retryAfterMs: null, ...overrides }
}

describe("decideSettlement", () => {
  it.each([
    [0, 30_000],
    [1, 2 * 60_000],
    [2, 8 * 60_000],
    [3, 32 * 60_000],
  ])("retries an unreachable push service after attempt %i on the fixed backoff", (attemptsBefore, delayMs) => {
    expect(decideSettlement({ result: result({}), attemptsBefore, nowMs: NOW, deadline: DAY_LATER })).toEqual({
      kind: "retry",
      nextAttemptAt: new Date(NOW + delayMs),
      outcome: "unreachable",
      statusCode: 503,
    })
  })

  it("fails for good once the fifth provider attempt is unreachable", () => {
    expect(PUSH_MAX_ATTEMPTS).toBe(5)
    expect(decideSettlement({ result: result({}), attemptsBefore: 4, nowMs: NOW, deadline: DAY_LATER })).toEqual({
      kind: "terminal",
      status: "failed",
      attempted: true,
      outcome: "unreachable",
      statusCode: 503,
      reason: "max_attempts",
    })
  })

  it("waits the push service's Retry-After when it is longer than the backoff", () => {
    const settlement = decideSettlement({
      result: result({ statusCode: 429, retryAfterMs: 5 * 60_000 }),
      attemptsBefore: 0,
      nowMs: NOW,
      deadline: DAY_LATER,
    })
    expect(settlement).toEqual({
      kind: "retry",
      nextAttemptAt: new Date(NOW + 5 * 60_000),
      outcome: "unreachable",
      statusCode: 429,
    })
  })

  it("expires instead of shortening a Retry-After that reaches past the send window", () => {
    const settlement = decideSettlement({
      result: result({ statusCode: 429, retryAfterMs: 2 * 60 * 60_000 }),
      attemptsBefore: 0,
      nowMs: NOW,
      deadline: new Date(NOW + 60 * 60_000),
    })
    expect(settlement).toEqual({
      kind: "terminal",
      status: "expired",
      attempted: true,
      outcome: "unreachable",
      statusCode: 429,
      reason: "retry_window_closed",
    })
  })

  it.each([
    ["accepted", 201, "accepted", null],
    ["registration_gone", 410, "registration_gone", null],
    ["rejected", 400, "rejected", "rejected"],
    ["invalid_registration", null, "rejected", "invalid_registration"],
  ] as const)("settles %s terminally without a retry", (outcome, statusCode, status, reason) => {
    expect(
      decideSettlement({ result: result({ outcome, statusCode }), attemptsBefore: 0, nowMs: NOW, deadline: DAY_LATER })
    ).toEqual({ kind: "terminal", status, attempted: true, outcome, statusCode, reason })
  })
})
