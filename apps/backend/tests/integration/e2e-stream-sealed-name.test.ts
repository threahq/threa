/**
 * E2E sealed-stream-name integration tests.
 *
 * Exercises the runtime path that unit tests can't: the additive migration
 * columns on `e2e_streams`, `updateSealedName`'s BYTEA + JSONB binding, the
 * `streams ⋈ e2e_streams` read projection, and `mapRowToStream`'s base64
 * surfacing — end-to-end against a real Postgres.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { StreamTypes } from "@threa/types"
import { setupTestDatabase, withTransaction, addTestMember } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { userId, workspaceId, streamId } from "../../src/lib/id"

const ENVELOPE = { v: 2, keyGeneration: 0, iv: "aXYxMjM0NTY3OA==", aad: "c3RyZWFtfG5hbWV8MA==" }

describe("E2E sealed stream name", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  /** Insert a workspace + member + scratchpad, optionally marking it E2E. */
  async function seedStream(e2e: boolean): Promise<{ wsId: string; sId: string; ownerId: string }> {
    const wsId = workspaceId()
    let ownerId = userId()
    const sId = streamId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: wsId,
        name: "Sealed Name WS",
        slug: `sealed-name-${wsId}`,
        createdBy: ownerId,
      })
      ownerId = (await addTestMember(client, wsId, ownerId)).id
      await StreamRepository.insert(client, {
        id: sId,
        workspaceId: wsId,
        type: StreamTypes.SCRATCHPAD,
        createdBy: ownerId,
      })
      if (e2e) {
        await E2eStreamsRepository.markStreamE2e(client, {
          streamId: sId,
          workspaceId: wsId,
          ownerUserId: ownerId,
          ownerUserKeyId: "e2ek_owner",
        })
      }
    })
    return { wsId, sId, ownerId }
  }

  test("stores the sealed name and surfaces it (base64 + envelope) on the joined stream", async () => {
    const { wsId, sId } = await seedStream(true)
    const ciphertext = Buffer.from("sealed-display-name-ciphertext").toString("base64")

    const updated = await E2eStreamsRepository.updateSealedName(pool, wsId, sId, { ciphertext, envelope: ENVELOPE })
    expect(updated).toBe(true)

    const stream = await StreamRepository.findById(pool, sId)
    expect(stream?.e2eEnabled).toBe(true)
    expect(stream?.sealedNameCiphertext).toBe(ciphertext)
    expect(stream?.sealedNameEnvelope).toEqual(ENVELOPE)
  })

  test("a freshly-marked E2E stream has a null sealed name until first rename", async () => {
    const { sId } = await seedStream(true)
    const stream = await StreamRepository.findById(pool, sId)
    expect(stream?.e2eEnabled).toBe(true)
    expect(stream?.sealedNameCiphertext).toBeNull()
    expect(stream?.sealedNameEnvelope).toBeNull()
  })

  test("updateSealedName no-ops for a plaintext (non-E2E) stream", async () => {
    const { wsId, sId } = await seedStream(false)

    const updated = await E2eStreamsRepository.updateSealedName(pool, wsId, sId, {
      ciphertext: Buffer.from("x").toString("base64"),
      envelope: ENVELOPE,
    })
    expect(updated).toBe(false)

    const stream = await StreamRepository.findById(pool, sId)
    // Plaintext streams omit the E2E join fields entirely.
    expect(stream?.e2eEnabled).toBeUndefined()
    expect(stream?.sealedNameCiphertext).toBeUndefined()
  })

  test("null clears a previously-stored sealed name (rename without a fresh seal)", async () => {
    const { wsId, sId } = await seedStream(true)
    const ciphertext = Buffer.from("sealed-name").toString("base64")
    await E2eStreamsRepository.updateSealedName(pool, wsId, sId, { ciphertext, envelope: ENVELOPE })
    expect((await StreamRepository.findById(pool, sId))?.sealedNameCiphertext).toBe(ciphertext)

    const cleared = await E2eStreamsRepository.updateSealedName(pool, wsId, sId, null)
    expect(cleared).toBe(true)
    const stream = await StreamRepository.findById(pool, sId)
    expect(stream?.sealedNameCiphertext).toBeNull()
    expect(stream?.sealedNameEnvelope).toBeNull()
  })

  test("rejects non-canonical base64 instead of storing a corrupt blob", async () => {
    const { wsId, sId } = await seedStream(true)
    await expect(
      E2eStreamsRepository.updateSealedName(pool, wsId, sId, { ciphertext: "!!!!", envelope: ENVELOPE })
    ).rejects.toThrow(/base64/)
  })
})
