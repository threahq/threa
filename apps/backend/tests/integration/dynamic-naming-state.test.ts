import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { DynamicNamingStateRepository as repo } from "../../src/features/dynamic-naming"

const workspace = "ws_dynamic_naming_test"
const otherWorkspace = "ws_dynamic_naming_other"

describe("dynamic naming state repository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query("DELETE FROM dynamic_naming_state WHERE workspace_id IN ($1, $2)", [workspace, otherWorkspace])
  })

  test("ensure is idempotent and workspace isolated", async () => {
    const first = await repo.ensure(pool, { workspaceId: workspace, targetKind: "stream", targetId: "stream_dn_1" })
    const second = await repo.ensure(pool, { workspaceId: workspace, targetKind: "stream", targetId: "stream_dn_1" })
    await repo.ensure(pool, { workspaceId: otherWorkspace, targetKind: "stream", targetId: "stream_dn_1" })
    expect(second.id).toBe(first.id)
    expect(await repo.find(pool, otherWorkspace, "stream", "stream_dn_1")).not.toBeNull()
    expect(await repo.find(pool, workspace, "stream", "missing")).toBeNull()
  })

  test("read and claim cannot cross workspace boundaries", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_isolation",
    })
    expect(await repo.find(pool, otherWorkspace, "stream", state.targetId)).toBeNull()
    expect(
      await repo.claim(pool, {
        workspaceId: otherWorkspace,
        targetKind: "stream",
        targetId: state.targetId,
        ownerId: "worker",
        checkpoint: 1,
        messageCount: 1,
        structureVersion: 0,
        titleRevision: 1,
        expectedVersion: state.version,
        leaseSeconds: 60,
      })
    ).toBeNull()
    expect(await repo.find(pool, workspace, "stream", state.targetId)).toMatchObject({
      claimToken: null,
      version: state.version,
    })
  })

  test("two concurrent claimers have one winner", async () => {
    const state = await repo.ensure(pool, { workspaceId: workspace, targetKind: "stream", targetId: "stream_dn_claim" })
    const claims = await Promise.all([
      repo.claim(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: "stream_dn_claim",
        ownerId: "worker_a",
        checkpoint: 1,
        messageCount: 1,
        structureVersion: 0,
        titleRevision: 1,
        expectedVersion: state.version,
        leaseSeconds: 60,
      }),
      repo.claim(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: "stream_dn_claim",
        ownerId: "worker_b",
        checkpoint: 1,
        messageCount: 1,
        structureVersion: 0,
        titleRevision: 1,
        expectedVersion: state.version,
        leaseSeconds: 60,
      }),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
  })

  test("session-owned lease renewal preserves its observed revision and terminal release clears it", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_session_owner",
    })
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: state.targetId,
      ownerId: "session_1",
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 0,
      expectedVersion: state.version,
      leaseSeconds: 1,
    })
    expect(await repo.renewOwnedClaimLease(pool, { ownerId: "session_1", leaseSeconds: 60 })).toBe(1)
    expect(await repo.find(pool, workspace, "stream", state.targetId)).toMatchObject({
      version: claim!.version,
      claimOwnerId: "session_1",
    })
    const observed = await repo.advanceOwnedClaimObservation(pool, {
      ownerId: "session_1",
      token: claim!.claimToken!,
      expectedVersion: claim!.version,
      checkpoint: 3,
      messageCount: 3,
    })
    expect(observed).toMatchObject({ version: claim!.version + 1, claimCheckpoint: 3, claimMessageCount: 3 })
    expect(await repo.releaseOwnedClaim(pool, "session_1")).toBe(1)
    expect(await repo.find(pool, workspace, "stream", state.targetId)).toMatchObject({
      version: claim!.version + 2,
      claimOwnerId: null,
      claimToken: null,
    })
  })

  test("renewal is token/version fenced and renewed claims cannot be reclaimed", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_renew",
    })
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: state.targetId,
      ownerId: "worker_a",
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 1,
      expectedVersion: state.version,
      leaseSeconds: 1,
    })
    expect(
      await repo.renewClaim(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: state.targetId,
        token: "wrong",
        expectedVersion: claim!.version,
        leaseSeconds: 60,
      })
    ).toBeNull()
    const renewed = await repo.renewClaim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: state.targetId,
      token: claim!.claimToken!,
      expectedVersion: claim!.version,
      leaseSeconds: 60,
    })
    expect(renewed).toMatchObject({ claimToken: claim!.claimToken, version: claim!.version + 1 })
    expect(await repo.recoverExpiredClaims(pool, workspace, 1)).toBe(0)
    expect(
      await repo.renewClaim(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: state.targetId,
        token: claim!.claimToken!,
        expectedVersion: claim!.version,
        leaseSeconds: 60,
      })
    ).toBeNull()
  })

  test("expired claims recover and stale token/version cannot apply", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_expiry",
    })
    const expired = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_expiry",
      ownerId: "worker_a",
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 1,
      expectedVersion: state.version,
      leaseSeconds: -1,
    })
    expect(await repo.recoverExpiredClaims(pool, workspace, 1)).toBe(1)
    const recovered = await repo.find(pool, workspace, "stream", "stream_dn_expiry")
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_expiry",
      ownerId: "worker_b",
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 1,
      expectedVersion: recovered!.version,
      leaseSeconds: 60,
    })
    expect(
      await repo.applyDecision(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: "stream_dn_expiry",
        token: expired!.claimToken!,
        expectedVersion: expired!.version,
        titleRevision: 1,
        decision: { action: "keep" },
      })
    ).toBeNull()
    expect(
      await repo.applyDecision(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: "stream_dn_expiry",
        token: claim!.claimToken!,
        expectedVersion: claim!.version + 1,
        titleRevision: 1,
        decision: { action: "keep" },
      })
    ).toBeNull()
    expect(
      await repo.applyDecision(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: "stream_dn_expiry",
        token: claim!.claimToken!,
        expectedVersion: claim!.version,
        titleRevision: 1,
        decision: { action: "keep" },
      })
    ).toMatchObject({ state: { consecutiveKeeps: 1 }, consumedClaim: { checkpoint: 1, messageCount: 1 } })
  })

  test("structural events dedupe monotonically and regeneration resets", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "conversation",
      targetId: "conv_dn_structure",
    })
    expect(
      await repo.recordStructuralEvent(pool, {
        workspaceId: workspace,
        targetKind: "conversation",
        targetId: state.targetId,
        eventId: "20",
      })
    ).toMatchObject({ structureVersion: 1 })
    expect(
      await repo.recordStructuralEvent(pool, {
        workspaceId: workspace,
        targetKind: "conversation",
        targetId: state.targetId,
        eventId: "20",
      })
    ).toBeNull()
    expect(
      await repo.recordStructuralEvent(pool, {
        workspaceId: workspace,
        targetKind: "conversation",
        targetId: state.targetId,
        eventId: "19",
      })
    ).toBeNull()
    const current = await repo.find(pool, workspace, "conversation", state.targetId)
    expect(
      await repo.resetForRegeneration(pool, {
        workspaceId: workspace,
        targetKind: "conversation",
        targetId: state.targetId,
        expectedVersion: current!.version,
      })
    ).toMatchObject({ structureVersion: 2, consecutiveKeeps: 0, completedAt: null })
  })

  test("release is token, version, and workspace fenced", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_release",
    })
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: state.targetId,
      ownerId: "worker",
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 2,
      expectedVersion: state.version,
      leaseSeconds: 60,
    })
    expect(
      await repo.release(pool, {
        workspaceId: otherWorkspace,
        targetKind: "stream",
        targetId: state.targetId,
        token: claim!.claimToken!,
        expectedVersion: claim!.version,
      })
    ).toBeNull()
    expect(
      await repo.release(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: state.targetId,
        token: "wrong",
        expectedVersion: claim!.version,
      })
    ).toBeNull()
    expect(
      await repo.release(pool, {
        workspaceId: workspace,
        targetKind: "stream",
        targetId: state.targetId,
        token: claim!.claimToken!,
        expectedVersion: claim!.version,
      })
    ).toMatchObject({ claimToken: null })
  })

  test("expired claims cannot apply directly and wrong workspace cannot mutate", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_direct_expired",
    })
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: state.targetId,
      ownerId: "worker",
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 3,
      expectedVersion: state.version,
      leaseSeconds: -1,
    })
    const apply = {
      targetKind: "stream" as const,
      targetId: state.targetId,
      token: claim!.claimToken!,
      expectedVersion: claim!.version,
      titleRevision: 3,
      decision: { action: "keep" as const },
    }
    expect(await repo.applyDecision(pool, { workspaceId: workspace, ...apply })).toBeNull()
    expect(await repo.applyDecision(pool, { workspaceId: otherWorkspace, ...apply })).toBeNull()
    expect(
      await repo.recordStructuralEvent(pool, {
        workspaceId: otherWorkspace,
        targetKind: "stream",
        targetId: state.targetId,
        eventId: "1",
      })
    ).toBeNull()
    expect(
      await repo.resetForRegeneration(pool, {
        workspaceId: otherWorkspace,
        targetKind: "stream",
        targetId: state.targetId,
        expectedVersion: claim!.version,
      })
    ).toBeNull()
    expect(await repo.recoverExpiredClaims(pool, otherWorkspace, 10)).toBe(0)
  })

  test("apply enforces pinned revision and forced checkpoint policy", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_policy",
    })
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: state.targetId,
      ownerId: "worker",
      checkpoint: 3,
      messageCount: 3,
      structureVersion: 0,
      titleRevision: 4,
      expectedVersion: state.version,
      leaseSeconds: 60,
    })
    const base = {
      workspaceId: workspace,
      targetKind: "stream" as const,
      targetId: state.targetId,
      token: claim!.claimToken!,
      expectedVersion: claim!.version,
    }
    expect(await repo.applyDecision(pool, { ...base, titleRevision: 5, decision: { action: "keep" } })).toBeNull()
    expect(await repo.applyDecision(pool, { ...base, titleRevision: 4, decision: { action: "defer" } })).toBeNull()
    expect(await repo.applyDecision(pool, { ...base, titleRevision: 4, decision: { action: "keep" } })).toMatchObject({
      state: { lastEvaluatedMessageCount: 3 },
      consumedClaim: { checkpoint: 3, messageCount: 3, reason: "ordinary" },
    })
  })

  test("regeneration claims consume their observed message frontier", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "conversation",
      targetId: "conv_dn_regenerate",
    })
    const reset = await repo.resetForRegeneration(pool, {
      workspaceId: workspace,
      targetKind: "conversation",
      targetId: state.targetId,
      expectedVersion: state.version,
    })
    const claim = await repo.claim(pool, {
      workspaceId: workspace,
      targetKind: "conversation",
      targetId: state.targetId,
      ownerId: "worker",
      checkpoint: 10,
      messageCount: 12,
      structureVersion: reset!.structureVersion,
      titleRevision: 8,
      expectedVersion: reset!.version,
      leaseSeconds: 60,
    })
    expect(claim).toMatchObject({ claimReason: "regenerate" })
    const applied = await repo.applyDecision(pool, {
      workspaceId: workspace,
      targetKind: "conversation",
      targetId: state.targetId,
      token: claim!.claimToken!,
      expectedVersion: claim!.version,
      titleRevision: 8,
      decision: { action: "keep" },
    })
    expect(applied).toMatchObject({
      state: { lastEvaluatedMessageCount: 12, regenerationPending: false, completedAt: expect.any(Date) },
      consumedClaim: { checkpoint: 10, messageCount: 12, reason: "regenerate" },
    })
  })

  test("orphan cleanup preserves live targets", async () => {
    const targetId = "stream_dn_live"
    await pool.query(
      "INSERT INTO streams (id, workspace_id, slug, display_name, type, created_by) VALUES ($1, $2, $3, $4, 'channel', $5)",
      [targetId, workspace, "dn-live", "Live", "usr_dn_live"]
    )
    await repo.ensure(pool, { workspaceId: workspace, targetKind: "stream", targetId })
    await repo.cleanupOrphans(pool, workspace, 10)
    expect(await repo.find(pool, workspace, "stream", targetId)).not.toBeNull()
    await pool.query("DELETE FROM streams WHERE id = $1", [targetId])
  })

  test("orphan cleanup cannot cross workspace boundaries", async () => {
    const state = await repo.ensure(pool, {
      workspaceId: workspace,
      targetKind: "stream",
      targetId: "stream_dn_wrong_workspace_orphan",
    })
    expect(await repo.cleanupOrphans(pool, otherWorkspace, 10)).toBe(0)
    expect(await repo.find(pool, workspace, "stream", state.targetId)).not.toBeNull()
  })

  test("orphan cleanup is bounded and set based", async () => {
    for (const targetId of ["stream_dn_orphan_a", "stream_dn_orphan_b", "stream_dn_orphan_c"]) {
      await repo.ensure(pool, { workspaceId: workspace, targetKind: "stream", targetId })
    }
    expect(await repo.cleanupOrphans(pool, workspace, 2)).toBe(2)
    const remaining = await pool.query("SELECT id FROM dynamic_naming_state WHERE workspace_id = $1", [workspace])
    expect(remaining.rows).toHaveLength(1)
  })
})
