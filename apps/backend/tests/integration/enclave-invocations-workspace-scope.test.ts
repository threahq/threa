import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../src/features/e2e-streams"
import { MessageRepository } from "../../src/features/messaging"
import { EnclaveInvocationsRepository, EnclaveRuntimesRepository } from "../../src/features/enclave-runtimes"
import { enclaveInvocationId, enclaveRuntimeId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"

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
})
