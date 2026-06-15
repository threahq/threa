/**
 * Integration coverage for the proactive re-wrap nudge's trigger query,
 * `EnclaveInvocationsRepository.findUnservablePending`, against a real Postgres.
 *
 * The mock-Querier unit test pins the SQL shape; this proves the behaviour the
 * shape can't: that a turn surfaces as unservable exactly when a live enclave
 * exists but no single live EIK holds wraps for BOTH the reply generation and
 * the trigger generation — the inverse of the claim predicate — paired with the
 * owner who can heal it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../src/features/e2e-streams"
import { MessageRepository } from "../../src/features/messaging"
import { EnclaveRuntimesRepository, EnclaveInvocationsRepository } from "../../src/features/enclave-runtimes"
import { userId, workspaceId, streamId, messageId, enclaveInvocationId, enclaveRuntimeId } from "../../src/lib/id"

const STALENESS_MS = 2 * 60 * 1000
const EMPTY_DOC = { type: "doc", content: [] }

interface WrapSpec {
  keyGeneration: number
  recipientKeyId: string
}
interface EikSpec {
  keyId: string
  revoked?: boolean
}

describe("findUnservablePending", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  /**
   * Seed a pending enclave invocation on an E2E scratchpad with a controllable
   * EIK fleet and wrap set. `currentGen` is the stream's reply generation; the
   * trigger message seals under `triggerGen`.
   */
  async function seed(params: {
    currentGen: number
    triggerGen: number
    eiks: EikSpec[]
    wraps: WrapSpec[]
  }): Promise<{ wsId: string; sId: string; ownerId: string; invId: string }> {
    const wsId = workspaceId()
    let ownerId = userId()
    const sId = streamId()
    const triggerId = messageId()
    const invId = enclaveInvocationId()

    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Rewrap WS",
        slug: `rewrap-${wsId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(client, wsId, ownerId)).id
      await StreamRepository.insert(client, {
        id: sId,
        workspaceId: wsId,
        type: StreamTypes.SCRATCHPAD,
        createdBy: ownerId,
      })
      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: sId,
        workspaceId: wsId,
        ownerUserId: ownerId,
        ownerUserKeyId: "e2ek_owner",
        currentKeyGeneration: params.currentGen,
      })
      await MessageRepository.insert(client, {
        id: triggerId,
        streamId: sId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        contentJson: EMPTY_DOC,
        contentMarkdown: "",
        ciphertext: Buffer.from("cipher:trigger"),
        envelope: { v: 2, keyGeneration: params.triggerGen, iv: "aXY=", aad: "YWFk" },
        e2eVersion: 2,
      })
      for (const eik of params.eiks) {
        await EnclaveRuntimesRepository.registerKey(client, {
          id: enclaveRuntimeId(),
          instanceId: `inst_${eik.keyId}`,
          keyId: eik.keyId,
          publicKey: new Uint8Array(32),
        })
        if (eik.revoked) await EnclaveRuntimesRepository.revoke(client, eik.keyId)
      }
      if (params.wraps.length > 0) {
        await StreamE2eKeyWrapsRepository.insertMany(
          client,
          params.wraps.map((w) => ({
            workspaceId: wsId,
            streamId: sId,
            keyGeneration: w.keyGeneration,
            recipientKeyId: w.recipientKeyId,
            recipientKind: "enclave" as const,
            wrapEnc: Buffer.from("enc").toString("base64"),
            wrapCt: Buffer.from("ct").toString("base64"),
          }))
        )
      }
      await EnclaveInvocationsRepository.insertPending(client, {
        id: invId,
        workspaceId: wsId,
        streamId: sId,
        rootStreamId: sId,
        messageId: triggerId,
        triggeredBy: ownerId,
      })
    })
    return { wsId, sId, ownerId, invId }
  }

  async function findFor(streamId: string) {
    const rows = await EnclaveInvocationsRepository.findUnservablePending(pool, { stalenessMs: STALENESS_MS })
    return rows.filter((r) => r.rootStreamId === streamId)
  }

  test("surfaces a stuck turn (live EIK, no wrap) paired with the stream owner", async () => {
    const { sId, ownerId, invId } = await seed({
      currentGen: 1,
      triggerGen: 1,
      eiks: [{ keyId: "eik_fresh" }],
      wraps: [],
    })

    const rows = await findFor(sId)
    expect(rows).toEqual([
      {
        id: invId,
        workspaceId: expect.any(String),
        rootStreamId: sId,
        ownerUserId: ownerId,
        createdAt: expect.any(Date),
      },
    ])
  })

  test("omits a servable turn — a live EIK holds wraps for both generations", async () => {
    const { sId } = await seed({
      currentGen: 1,
      triggerGen: 1,
      eiks: [{ keyId: "eik_live" }],
      wraps: [{ keyGeneration: 1, recipientKeyId: "eik_live" }],
    })
    expect(await findFor(sId)).toEqual([])
  })

  test("omits a turn with no live EIK — a zero-instance gap is ops, not an owner re-wrap", async () => {
    const { sId } = await seed({
      currentGen: 1,
      triggerGen: 1,
      eiks: [{ keyId: "eik_gone", revoked: true }],
      // Even with a wrap on the books, a revoked EIK isn't a re-wrap target.
      wraps: [{ keyGeneration: 1, recipientKeyId: "eik_gone" }],
    })
    // The runtime registry is global infra (one fleet serves every workspace),
    // so isolate the genuine zero-instance state by clearing live EIKs other
    // cases registered — with none live, there is nowhere for the owner to
    // re-wrap and the turn must not surface.
    await pool.query("DELETE FROM enclave_runtimes")
    expect(await findFor(sId)).toEqual([])
  })

  test("surfaces a turn whose live EIK covers the reply gen but not the trigger's", async () => {
    // Stream rolled to gen 2; the trigger still seals under gen 1. The live EIK
    // only holds gen 2, so it can seal the reply but can't open the prompt.
    const { sId } = await seed({
      currentGen: 2,
      triggerGen: 1,
      eiks: [{ keyId: "eik_partial" }],
      wraps: [{ keyGeneration: 2, recipientKeyId: "eik_partial" }],
    })
    expect(await findFor(sId)).toHaveLength(1)
  })

  test("omits the same turn once one live EIK covers both generations", async () => {
    const { sId } = await seed({
      currentGen: 2,
      triggerGen: 1,
      eiks: [{ keyId: "eik_full" }],
      wraps: [
        { keyGeneration: 1, recipientKeyId: "eik_full" },
        { keyGeneration: 2, recipientKeyId: "eik_full" },
      ],
    })
    expect(await findFor(sId)).toEqual([])
  })

  test("requires ONE EIK to cover both gens — coverage split across two EIKs is still unservable", async () => {
    // eik_a opens the prompt (gen 1), eik_b seals the reply (gen 2), but neither
    // can do both — exactly the claim predicate's both-sides rule.
    const { sId } = await seed({
      currentGen: 2,
      triggerGen: 1,
      eiks: [{ keyId: "eik_a" }, { keyId: "eik_b" }],
      wraps: [
        { keyGeneration: 1, recipientKeyId: "eik_a" },
        { keyGeneration: 2, recipientKeyId: "eik_b" },
      ],
    })
    expect(await findFor(sId)).toHaveLength(1)
  })
})
