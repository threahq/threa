import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../src/features/e2e-streams"
import { MessageRepository } from "../../src/features/messaging"
import { EnclaveInvocationsRepository, EnclaveRuntimesRepository } from "../../src/features/enclave-runtimes"
import {
  enclaveInvocationId,
  enclaveRuntimeId,
  messageId,
  sessionId,
  streamId,
  userId,
  workspaceId,
} from "../../src/lib/id"

const EMPTY_DOC = { type: "doc", content: [] }
const MAX_ATTEMPTS = 5
const STALENESS_MS = 2 * 60 * 1000

interface Seeded {
  wsId: string
  sId: string
  ownerId: string
  mId: string
}

interface Generations {
  currentGen?: number
  triggerGen?: number
  wrapGens?: number[]
}

interface InvocationRow {
  id: string
  workspace_id: string
  status: string
  claimed_by_key_id: string | null
  claim_token: string | null
  session_id: string | null
  attempts: number
  error_message: string | null
}

describe("Enclave invocations workspace scope (INV-8)", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedWorkspace(label: string, keyId: string, gens: Generations = {}): Promise<Seeded> {
    const { currentGen = 1, triggerGen = 1, wrapGens = [1] } = gens
    const wsId = workspaceId()
    const sId = streamId()
    const mId = messageId()
    let ownerId = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: `Enclave scope ${label}`,
        slug: `enclave-scope-${label}-${wsId}`,
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
        currentKeyGeneration: currentGen,
      })
      await StreamE2eKeyWrapsRepository.insertMany(
        client,
        wrapGens.map((keyGeneration) => wrapRow(wsId, sId, keyGeneration, keyId))
      )
      await MessageRepository.insert(client, {
        workspaceId: wsId,
        id: mId,
        streamId: sId,
        sequence: 1n,
        authorId: ownerId,
        authorType: "user",
        contentJson: EMPTY_DOC,
        contentMarkdown: "",
        ciphertext: Buffer.from("cipher:trigger"),
        envelope: { v: 2, keyGeneration: triggerGen, iv: "aXY=", aad: "YWFk" },
        e2eVersion: 2,
      })
    })
    return { wsId, sId, ownerId, mId }
  }

  const wrapRow = (wsId: string, sId: string, keyGeneration: number, keyId: string) => ({
    workspaceId: wsId,
    streamId: sId,
    keyGeneration,
    recipientKeyId: keyId,
    recipientKind: "enclave" as const,
    wrapEnc: Buffer.from("enc").toString("base64"),
    wrapCt: Buffer.from("ct").toString("base64"),
  })

  // A wrap row stamped with one workspace under a stream id another workspace's invocation points at.
  async function insertForeignWrap(wrapWorkspaceId: string, targetStreamId: string, gen: number, keyId: string) {
    await StreamE2eKeyWrapsRepository.insertMany(pool, [wrapRow(wrapWorkspaceId, targetStreamId, gen, keyId)])
  }

  async function seedScope(aGens: Generations = {}) {
    const keyId = `eik_scope_${enclaveRuntimeId()}`
    return { keyId, a: await seedWorkspace("a", keyId, aGens), b: await seedWorkspace("b", keyId) }
  }

  async function registerLiveKey(keyId: string) {
    await EnclaveRuntimesRepository.registerKey(pool, {
      id: enclaveRuntimeId(),
      instanceId: `inst_${keyId}`,
      keyId,
      publicKey: new Uint8Array(32),
    })
  }

  async function insertInvocation(
    owner: Seeded,
    pointing: { messageId?: string; rootStreamId?: string } = {}
  ): Promise<string> {
    const id = enclaveInvocationId()
    await EnclaveInvocationsRepository.insertPending(pool, {
      id,
      workspaceId: owner.wsId,
      streamId: owner.sId,
      rootStreamId: pointing.rootStreamId ?? owner.sId,
      messageId: pointing.messageId ?? owner.mId,
      triggeredBy: owner.ownerId,
    })
    return id
  }

  async function holdClaim(id: string, held: { keyId: string; token: string; sessionId: string | null }) {
    await pool.query(
      `UPDATE enclave_invocations
       SET status = 'claimed', claimed_by_key_id = $2, claim_token = $3, session_id = $4,
           claim_expires_at = NOW() + INTERVAL '10 minutes', attempts = 1
       WHERE id = $1`,
      [id, held.keyId, held.token, held.sessionId]
    )
  }

  async function snapshot(ids: string[]): Promise<Record<string, InvocationRow>> {
    const result = await pool.query<InvocationRow>(
      `SELECT id, workspace_id, status, claimed_by_key_id, claim_token, session_id, attempts, error_message
       FROM enclave_invocations WHERE id = ANY($1)`,
      [ids]
    )
    return Object.fromEntries(result.rows.map((row) => [row.id, row]))
  }

  const outcome = (row: InvocationRow) => ({ status: row.status, error: row.error_message })

  async function claimExpiry(id: string): Promise<number> {
    const result = await pool.query<{ claim_expires_at: Date }>(
      "SELECT claim_expires_at FROM enclave_invocations WHERE id = $1",
      [id]
    )
    return result.rows[0]!.claim_expires_at.getTime()
  }

  const claimParams = (keyId: string, invocationId: string) => ({
    invocationId,
    keyId,
    claimToken: "cbtok_scope",
    claimTtlSeconds: 60,
    maxAttempts: MAX_ATTEMPTS,
  })

  async function pollAndClaim(keyId: string, claimWorkspaceId: string, invocationId: string) {
    const offered = await EnclaveInvocationsRepository.findNextClaimable(pool, { keyId, maxAttempts: MAX_ATTEMPTS })
    const claimed = await EnclaveInvocationsRepository.claimNext(
      pool,
      claimWorkspaceId,
      claimParams(keyId, invocationId)
    )
    return { offered: offered?.id ?? null, claimed: claimed?.id ?? null }
  }

  describe("claim gate", () => {
    test("should offer the invocation whose trigger message lives in its own workspace, never one pointing into another workspace", async () => {
      const { keyId, a, b } = await seedScope()
      await insertInvocation(a, { messageId: b.mId })
      const own = await insertInvocation(a)

      const offered = await EnclaveInvocationsRepository.findNextClaimable(pool, { keyId, maxAttempts: MAX_ATTEMPTS })

      expect(offered?.id).toBe(own)
    })

    test("should claim nothing when the trigger message belongs to another workspace", async () => {
      const { keyId, a, b } = await seedScope()
      const crossPointing = await insertInvocation(a, { messageId: b.mId })

      const claimed = await EnclaveInvocationsRepository.claimNext(pool, a.wsId, claimParams(keyId, crossPointing))

      expect(claimed).toBeNull()
      expect(await snapshot([crossPointing])).toEqual({
        [crossPointing]: {
          id: crossPointing,
          workspace_id: a.wsId,
          status: "pending",
          claimed_by_key_id: null,
          claim_token: null,
          session_id: null,
          attempts: 0,
          error_message: null,
        },
      })
    })

    test("should claim an invocation only through its own workspace", async () => {
      const { keyId, a, b } = await seedScope()
      const id = await insertInvocation(a)

      const throughOther = await EnclaveInvocationsRepository.claimNext(pool, b.wsId, claimParams(keyId, id))
      const untouched = await snapshot([id])
      const throughOwn = await EnclaveInvocationsRepository.claimNext(pool, a.wsId, claimParams(keyId, id))

      expect(throughOther).toBeNull()
      expect(untouched[id]).toMatchObject({ status: "pending", claimed_by_key_id: null, attempts: 0 })
      expect(throughOwn).toMatchObject({
        id,
        workspaceId: a.wsId,
        status: "claimed",
        claimedByKeyId: keyId,
        claimToken: "cbtok_scope",
        attempts: 1,
      })
    })

    test("should report a pending turn as unservable when its trigger message belongs to another workspace", async () => {
      const { keyId, a, b } = await seedScope()
      await registerLiveKey(keyId)
      const crossPointing = await insertInvocation(a, { messageId: b.mId })
      await insertInvocation(a)

      const rows = await EnclaveInvocationsRepository.findUnservablePending(pool, { stalenessMs: STALENESS_MS })

      expect(rows.filter((row) => row.rootStreamId === a.sId || row.rootStreamId === b.sId)).toEqual([
        {
          id: crossPointing,
          workspaceId: a.wsId,
          rootStreamId: a.sId,
          ownerUserId: a.ownerId,
          createdAt: expect.any(Date),
        },
      ])
    })

    test("should neither offer nor claim a turn whose reply-generation wrap exists only in another workspace", async () => {
      const { keyId, a, b } = await seedScope({ currentGen: 2, triggerGen: 1, wrapGens: [1] })
      await insertForeignWrap(b.wsId, a.sId, 2, keyId)
      const id = await insertInvocation(a)

      expect(await pollAndClaim(keyId, a.wsId, id)).toEqual({ offered: null, claimed: null })
    })

    test("should neither offer nor claim a turn whose prompt-generation wrap exists only in another workspace", async () => {
      const { keyId, a, b } = await seedScope({ currentGen: 2, triggerGen: 1, wrapGens: [2] })
      await insertForeignWrap(b.wsId, a.sId, 1, keyId)
      const id = await insertInvocation(a)

      expect(await pollAndClaim(keyId, a.wsId, id)).toEqual({ offered: null, claimed: null })
    })

    test("should neither offer nor claim a turn whose root stream belongs to another workspace", async () => {
      const { keyId, a, b } = await seedScope()
      await insertForeignWrap(a.wsId, b.sId, 1, keyId)
      const id = await insertInvocation(a, { rootStreamId: b.sId })

      expect(await pollAndClaim(keyId, a.wsId, id)).toEqual({ offered: null, claimed: null })
    })

    test("should report only turns whose own workspace lacks the covering wraps, never ones another workspace covers or roots", async () => {
      const reply = await seedScope({ currentGen: 2, triggerGen: 1, wrapGens: [1] })
      await insertForeignWrap(reply.b.wsId, reply.a.sId, 2, reply.keyId)
      const prompt = await seedScope({ currentGen: 2, triggerGen: 1, wrapGens: [2] })
      await insertForeignWrap(prompt.b.wsId, prompt.a.sId, 1, prompt.keyId)
      const crossRoot = await seedScope()
      for (const { keyId } of [reply, prompt, crossRoot]) await registerLiveKey(keyId)
      const replyUncovered = await insertInvocation(reply.a)
      const promptUncovered = await insertInvocation(prompt.a)
      await insertInvocation(crossRoot.a, { rootStreamId: crossRoot.b.sId })

      const rows = await EnclaveInvocationsRepository.findUnservablePending(pool, { stalenessMs: STALENESS_MS })

      const own = [reply.a.wsId, prompt.a.wsId, crossRoot.a.wsId]
      expect(rows.filter((row) => own.includes(row.workspaceId)).map((row) => row.id)).toEqual([
        replyUncovered,
        promptUncovered,
      ])
    })
  })

  describe("writes by invocation id", () => {
    async function seedClaimed() {
      const { keyId, a, b } = await seedScope()
      const id = await insertInvocation(a)
      await holdClaim(id, { keyId, token: "cbtok_held", sessionId: null })
      return { keyId, a, b, id }
    }

    test("should stamp the session only through the owning workspace", async () => {
      const { a, b, id } = await seedClaimed()
      const stamped = sessionId()

      await EnclaveInvocationsRepository.attachSession(pool, { workspaceId: b.wsId, id, sessionId: stamped })
      const afterOther = (await snapshot([id]))[id]!.session_id
      await EnclaveInvocationsRepository.attachSession(pool, { workspaceId: a.wsId, id, sessionId: stamped })
      const afterOwn = (await snapshot([id]))[id]!.session_id

      expect({ afterOther, afterOwn }).toEqual({ afterOther: null, afterOwn: stamped })
    })

    test("should complete the claim only through the owning workspace", async () => {
      const { a, b, id } = await seedClaimed()

      await EnclaveInvocationsRepository.completeClaimed(pool, b.wsId, id)
      const afterOther = (await snapshot([id]))[id]!.status
      await EnclaveInvocationsRepository.completeClaimed(pool, a.wsId, id)
      const afterOwn = (await snapshot([id]))[id]!.status

      expect({ afterOther, afterOwn }).toEqual({ afterOther: "claimed", afterOwn: "completed" })
    })

    test("should fail the claim only through the owning workspace", async () => {
      const { keyId, a, b, id } = await seedClaimed()
      const failure = { id, keyId, claimToken: "cbtok_held", errorMessage: "denied" }

      await EnclaveInvocationsRepository.failClaimed(pool, { workspaceId: b.wsId, ...failure })
      const afterOther = (await snapshot([id]))[id]!
      await EnclaveInvocationsRepository.failClaimed(pool, { workspaceId: a.wsId, ...failure })
      const afterOwn = (await snapshot([id]))[id]!

      expect({ afterOther: outcome(afterOther), afterOwn: outcome(afterOwn) }).toEqual({
        afterOther: { status: "claimed", error: null },
        afterOwn: { status: "failed", error: "denied" },
      })
    })
  })

  describe("writes by session id", () => {
    // Session ids carry no uniqueness constraint, so a decoy in another
    // workspace can hold the very same session id as the live claim.
    async function seedSharedSession() {
      const { keyId, a, b } = await seedScope()
      const shared = sessionId()
      const own = await insertInvocation(a)
      const decoy = await insertInvocation(b)
      await holdClaim(own, { keyId, token: "cbtok_own", sessionId: shared })
      await holdClaim(decoy, { keyId, token: "cbtok_decoy", sessionId: shared })
      return { a, shared, own, decoy }
    }

    test("should complete only the owning workspace's claim for the session", async () => {
      const { a, shared, own, decoy } = await seedSharedSession()

      await EnclaveInvocationsRepository.completeBySession(pool, a.wsId, shared)
      const rows = await snapshot([own, decoy])

      expect({ own: rows[own]!.status, decoy: rows[decoy]!.status }).toEqual({ own: "completed", decoy: "claimed" })
    })

    test("should fail only the owning workspace's claim for the session", async () => {
      const { a, shared, own, decoy } = await seedSharedSession()

      await EnclaveInvocationsRepository.failBySession(pool, {
        workspaceId: a.wsId,
        sessionId: shared,
        errorMessage: "STREAM_READ_ONLY:archived",
      })
      const rows = await snapshot([own, decoy])

      expect({ own: outcome(rows[own]!), decoy: outcome(rows[decoy]!) }).toEqual({
        own: { status: "failed", error: "STREAM_READ_ONLY:archived" },
        decoy: { status: "claimed", error: null },
      })
    })

    test("should renew only the owning workspace's claim for the session", async () => {
      const { a, shared, own, decoy } = await seedSharedSession()
      const before = { own: await claimExpiry(own), decoy: await claimExpiry(decoy) }

      await EnclaveInvocationsRepository.renewBySession(pool, {
        workspaceId: a.wsId,
        sessionId: shared,
        claimTtlSeconds: 3600,
      })
      const after = { own: await claimExpiry(own), decoy: await claimExpiry(decoy) }

      expect({ ownRenewed: after.own > before.own, decoy: after.decoy }).toEqual({
        ownRenewed: true,
        decoy: before.decoy,
      })
    })
  })
})
