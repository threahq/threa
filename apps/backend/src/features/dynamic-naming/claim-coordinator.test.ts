import { describe, expect, test } from "bun:test"
import { DYNAMIC_NAMING_CLAIM_LEASE_SECONDS, DYNAMIC_NAMING_DECISION_TIMEOUT_MS } from "./config"
import { DynamicNamingClaimCoordinator } from "./claim-coordinator"

describe("dynamic naming claim coordinator", () => {
  test("decision provider receives an abort deadline comfortably below the lease", async () => {
    let receivedSignal: AbortSignal | undefined
    const coordinator = new DynamicNamingClaimCoordinator({} as never, {} as never)
    const decision = await coordinator.decide(
      {
        decide: async (_target, _checkpoint, _forced, signal) => {
          receivedSignal = signal
          return { action: "keep" }
        },
      },
      {
        workspaceId: "ws_1",
        targetKind: "stream",
        targetId: "stream_1",
        messageCount: 1,
        titleRevision: 1,
      },
      1,
      false
    )

    expect({ decision, aborted: receivedSignal?.aborted }).toEqual({
      decision: { action: "keep" },
      aborted: false,
    })
    expect(DYNAMIC_NAMING_CLAIM_LEASE_SECONDS * 1_000 - DYNAMIC_NAMING_DECISION_TIMEOUT_MS).toBeGreaterThanOrEqual(
      15_000
    )
  })
})
