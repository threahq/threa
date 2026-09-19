import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threahq/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../src/features/e2e-streams"
import { UserE2eKeysService, type KdfParams } from "../../src/features/user-e2e-keys"
import { userId, workspaceId, streamId } from "../../src/lib/id"

const KDF_PARAMS: KdfParams = { algorithm: "argon2id", m: 65536, t: 3, p: 1, version: 19 }

const PUBLIC_KEY = Buffer.alloc(32, 7)
const OTHER_PUBLIC_KEY = Buffer.alloc(32, 9)

describe("UserE2eKeysService.setUserKey key identity", () => {
  let pool: Pool
  let service: UserE2eKeysService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new UserE2eKeysService(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  /** Workspace + owner + a sealed scratchpad whose SSK is wrapped to the owner's UIK. */
  async function seed() {
    const wsId = workspaceId()
    const sealedId = streamId()

    const owner = await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Passphrase WS",
        slug: `passphrase-${wsId}`,
        createdBy: userId(),
      })
      const member = await addTestMember(client, wsId, userId())
      await StreamRepository.insert(client, {
        id: sealedId,
        workspaceId: wsId,
        name: "Sealed",
        slug: `sealed-${sealedId}`,
        type: StreamTypes.SCRATCHPAD,
        createdBy: member.id,
      })
      return member
    })

    const { key } = await service.setUserKey({
      workspaceId: wsId,
      userId: owner.id,
      publicKey: PUBLIC_KEY,
      encryptedPrivateBundle: Buffer.from("bundle-under-old-passphrase"),
      kdfSalt: Buffer.alloc(16, 1),
      kdfParams: KDF_PARAMS,
    })

    await withTransaction(pool, async (client) => {
      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: sealedId,
        workspaceId: wsId,
        ownerUserId: owner.id,
        ownerUserKeyId: key.keyId,
      })
      await StreamE2eKeyWrapsRepository.insertMany(client, [
        {
          workspaceId: wsId,
          streamId: sealedId,
          keyGeneration: 0,
          recipientKeyId: key.keyId,
          recipientKind: "user",
          wrapEnc: Buffer.from("enc").toString("base64"),
          wrapCt: Buffer.from("ct").toString("base64"),
        },
      ])
    })

    return { wsId, sealedId, ownerId: owner.id, keyId: key.keyId }
  }

  test("a passphrase change keeps the keyId, so existing stream wraps still address the key", async () => {
    const { wsId, sealedId, ownerId, keyId } = await seed()

    const rotated = await service.setUserKey({
      workspaceId: wsId,
      userId: ownerId,
      publicKey: PUBLIC_KEY,
      encryptedPrivateBundle: Buffer.from("bundle-under-new-passphrase"),
      kdfSalt: Buffer.alloc(16, 2),
      kdfParams: { ...KDF_PARAMS, t: 4 },
    })

    expect(rotated).toMatchObject({
      rotated: true,
      key: {
        keyId,
        encryptedPrivateBundle: Buffer.from("bundle-under-new-passphrase"),
        kdfSalt: Buffer.alloc(16, 2),
        kdfParams: { ...KDF_PARAMS, t: 4 },
      },
    })

    const active = await service.getActive(wsId, ownerId)
    expect(active).toMatchObject({ keyId, revokedAt: null })

    const [e2eStream, wraps] = await Promise.all([
      E2eStreamsRepository.getByStreamId(pool, wsId, sealedId),
      StreamE2eKeyWrapsRepository.listForStream(pool, wsId, sealedId),
    ])
    expect(e2eStream?.ownerUserKeyId).toBe(keyId)
    expect(wraps.map((wrap) => wrap.recipientKeyId)).toEqual([keyId])
  })

  test("a new public key is a real rotation: fresh keyId, old row revoked", async () => {
    const { wsId, ownerId, keyId } = await seed()

    const rotated = await service.setUserKey({
      workspaceId: wsId,
      userId: ownerId,
      publicKey: OTHER_PUBLIC_KEY,
      encryptedPrivateBundle: Buffer.from("bundle-for-a-new-key"),
      kdfSalt: Buffer.alloc(16, 3),
      kdfParams: KDF_PARAMS,
    })

    expect(rotated.rotated).toBe(true)
    expect(rotated.key.keyId).not.toBe(keyId)

    const active = await service.getActive(wsId, ownerId)
    expect(active?.keyId).toBe(rotated.key.keyId)

    const old = await pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM user_e2e_keys WHERE workspace_id = $1 AND key_id = $2",
      [wsId, keyId]
    )
    expect(old.rows[0]?.revoked_at).toBeInstanceOf(Date)
  })
})
