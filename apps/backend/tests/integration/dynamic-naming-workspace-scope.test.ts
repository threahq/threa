import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { DynamicNamingStateRepository as repo } from "../../src/features/dynamic-naming"

const wsA = "ws_dn_scope_a"
const wsB = "ws_dn_scope_b"
const targetId = "stream_dn_scope_shared"
const ownerId = "session_dn_scope"

async function seedUnclaimedPair(pool: Pool) {
  const stateA = await repo.ensure(pool, { workspaceId: wsA, targetKind: "stream", targetId })
  await repo.ensure(pool, { workspaceId: wsB, targetKind: "stream", targetId })
  return stateA
}

// Both workspaces own a state row for the same target id and the same claim
// owner; B's row is forced to carry A's token and version, so only the
// workspace_id pin separates them.
async function seedClaimedPair(pool: Pool) {
  const stateA = await seedUnclaimedPair(pool)
  const claimA = await repo.claim(pool, {
    workspaceId: wsA,
    targetKind: "stream",
    targetId,
    ownerId,
    checkpoint: 1,
    messageCount: 1,
    structureVersion: 0,
    titleRevision: 0,
    expectedVersion: stateA.version,
    leaseSeconds: 60,
  })
  await pool.query(
    `UPDATE dynamic_naming_state b SET
       claim_token = a.claim_token, claim_owner_id = a.claim_owner_id, claim_checkpoint = a.claim_checkpoint,
       claim_message_count = a.claim_message_count, claim_structure_version = a.claim_structure_version,
       claim_title_revision = a.claim_title_revision, claim_reason = a.claim_reason,
       claim_expires_at = a.claim_expires_at, version = a.version
     FROM dynamic_naming_state a
     WHERE a.workspace_id = $1 AND a.target_kind = 'stream' AND a.target_id = $3
       AND b.workspace_id = $2 AND b.target_kind = 'stream' AND b.target_id = $3`,
    [wsA, wsB, targetId]
  )
  return claimA!
}

describe("dynamic naming state workspace scope", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })
  afterAll(async () => {
    await pool.end()
  })
  beforeEach(async () => {
    await pool.query("DELETE FROM dynamic_naming_state WHERE workspace_id IN ($1, $2)", [wsA, wsB])
  })

  test("should extend only the named workspace's claim when renewing an owned claim lease", async () => {
    const claimA = await seedClaimedPair(pool)

    expect(await repo.renewOwnedClaimLease(pool, { workspaceId: wsA, ownerId, leaseSeconds: 600 })).toBe(1)

    const a = await repo.find(pool, wsA, "stream", targetId)
    const b = await repo.find(pool, wsB, "stream", targetId)
    expect(a!.claimExpiresAt!.getTime()).toBeGreaterThan(claimA.claimExpiresAt!.getTime() + 60_000)
    expect(b!.claimExpiresAt!.getTime()).toBe(claimA.claimExpiresAt!.getTime())
  })

  test("should move only the named workspace's claim when advancing an owned claim observation", async () => {
    const claimA = await seedClaimedPair(pool)

    const observed = await repo.advanceOwnedClaimObservation(pool, {
      workspaceId: wsA,
      ownerId,
      token: claimA.claimToken!,
      expectedVersion: claimA.version,
      checkpoint: 3,
      messageCount: 3,
    })

    expect(observed).toMatchObject({ workspaceId: wsA, version: claimA.version + 1, claimCheckpoint: 3 })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      version: claimA.version,
      claimCheckpoint: 1,
      claimMessageCount: 1,
    })
  })

  test("should find nothing when advancing an owned claim observation in a workspace that does not own the claim", async () => {
    const claimA = await seedClaimedPair(pool)
    await pool.query("DELETE FROM dynamic_naming_state WHERE workspace_id = $1", [wsB])

    const observed = await repo.advanceOwnedClaimObservation(pool, {
      workspaceId: wsB,
      ownerId,
      token: claimA.claimToken!,
      expectedVersion: claimA.version,
      checkpoint: 3,
      messageCount: 3,
    })

    expect(observed).toBeNull()
    expect(await repo.find(pool, wsA, "stream", targetId)).toMatchObject({
      version: claimA.version,
      claimCheckpoint: 1,
    })
  })

  test("should clear only the named workspace's claim when releasing an owned claim", async () => {
    const claimA = await seedClaimedPair(pool)

    expect(await repo.releaseOwnedClaim(pool, wsA, ownerId)).toBe(1)

    expect(await repo.find(pool, wsA, "stream", targetId)).toMatchObject({ claimOwnerId: null, claimToken: null })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      claimOwnerId: ownerId,
      claimToken: claimA.claimToken,
      version: claimA.version,
    })
  })

  test("should consume only the named workspace's claim when applying a decision", async () => {
    const claimA = await seedClaimedPair(pool)

    const applied = await repo.applyDecision(pool, {
      workspaceId: wsA,
      targetKind: "stream",
      targetId,
      token: claimA.claimToken!,
      expectedVersion: claimA.version,
      titleRevision: 0,
      decision: { action: "keep" },
    })

    expect(applied).toMatchObject({ state: { workspaceId: wsA } })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      claimToken: claimA.claimToken,
      version: claimA.version,
      consecutiveKeeps: 0,
    })
  })

  test("should take only the named workspace's row when claiming", async () => {
    const stateA = await seedUnclaimedPair(pool)

    const claimed = await repo.claim(pool, {
      workspaceId: wsA,
      targetKind: "stream",
      targetId,
      ownerId,
      checkpoint: 1,
      messageCount: 1,
      structureVersion: 0,
      titleRevision: 0,
      expectedVersion: stateA.version,
      leaseSeconds: 60,
    })

    expect(claimed).toMatchObject({ workspaceId: wsA, claimOwnerId: ownerId })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      claimToken: null,
      claimOwnerId: null,
      version: stateA.version,
    })
  })

  test("should extend only the named workspace's claim when renewing a claim", async () => {
    const claimA = await seedClaimedPair(pool)

    const renewed = await repo.renewClaim(pool, {
      workspaceId: wsA,
      targetKind: "stream",
      targetId,
      token: claimA.claimToken!,
      expectedVersion: claimA.version,
      leaseSeconds: 600,
    })

    expect(renewed).toMatchObject({ workspaceId: wsA, version: claimA.version + 1 })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({ version: claimA.version })
  })

  test("should clear only the named workspace's claim when releasing", async () => {
    const claimA = await seedClaimedPair(pool)

    const released = await repo.release(pool, {
      workspaceId: wsA,
      targetKind: "stream",
      targetId,
      token: claimA.claimToken!,
      expectedVersion: claimA.version,
    })

    expect(released).toMatchObject({ workspaceId: wsA, claimToken: null })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      claimToken: claimA.claimToken,
      version: claimA.version,
    })
  })

  test("should bump only the named workspace's structure version when recording a structural event", async () => {
    const stateA = await seedUnclaimedPair(pool)

    const recorded = await repo.recordStructuralEvent(pool, {
      workspaceId: wsA,
      targetKind: "stream",
      targetId,
      eventId: "5",
    })

    expect(recorded).toMatchObject({ workspaceId: wsA, structureVersion: stateA.structureVersion + 1 })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      structureVersion: stateA.structureVersion,
      version: stateA.version,
    })
  })

  test("should reset only the named workspace's row when resetting for regeneration", async () => {
    const stateA = await seedUnclaimedPair(pool)

    const reset = await repo.resetForRegeneration(pool, {
      workspaceId: wsA,
      targetKind: "stream",
      targetId,
      expectedVersion: stateA.version,
    })

    expect(reset).toMatchObject({ workspaceId: wsA, regenerationPending: true })
    expect(await repo.find(pool, wsB, "stream", targetId)).toMatchObject({
      regenerationPending: false,
      version: stateA.version,
    })
  })
})
