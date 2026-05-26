import type { Pool } from "pg"
import { sql, withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { userEncryptionKeyId } from "../../lib/id"
import { UserE2eKeysRepository, type KdfParams, type UserE2eKey } from "./repository"

export interface SetUserKeyInput {
  workspaceId: string
  userId: string
  publicKey: Buffer
  encryptedPrivateBundle: Buffer
  kdfSalt: Buffer
  kdfParams: KdfParams
}

export interface SetUserKeyResult {
  key: UserE2eKey
  rotated: boolean
}

export class UserE2eKeysService {
  constructor(private pool: Pool) {}

  async getActive(workspaceId: string, userId: string): Promise<UserE2eKey | null> {
    return UserE2eKeysRepository.getActiveByUser(this.pool, workspaceId, userId)
  }

  /**
   * Set the user's active E2E key. If one already exists, it's revoked in the
   * same transaction so the unique-active index never sees two live rows
   * (INV-20: race-safe write paths).
   *
   * Two concurrent setUserKey calls (e.g. user clicks Setup twice quickly, or
   * two devices race a passphrase rotation) would otherwise both pass the
   * `getActiveByUser` check, both try to insert, and one would fail on the
   * partial unique index. A per-(workspace,user) transaction-scoped advisory
   * lock serializes them so the loser waits instead of erroring.
   *
   * The server never sees the user's passphrase or the unwrapped private key.
   * It stores only the public half plus the passphrase-wrapped private bundle.
   */
  async setUserKey(input: SetUserKeyInput): Promise<SetUserKeyResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${input.workspaceId} || ':' || ${input.userId}, 0)
        )
      `)

      const existing = await UserE2eKeysRepository.getActiveByUser(client, input.workspaceId, input.userId)
      if (existing) {
        await UserE2eKeysRepository.revokeActive(client, input.workspaceId, input.userId)
      }

      const id = userEncryptionKeyId()
      const keyId = id
      const key = await UserE2eKeysRepository.insert(client, {
        id,
        keyId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        publicKey: input.publicKey,
        encryptedPrivateBundle: input.encryptedPrivateBundle,
        kdfSalt: input.kdfSalt,
        kdfParams: input.kdfParams,
      })

      return { key, rotated: existing !== null }
    })
  }

  /**
   * Revoke the user's active key. Permanently destroys access to any existing
   * E2E content encrypted to this key — the caller (handler) must surface a
   * loud confirmation before invoking this.
   */
  async revokeActive(workspaceId: string, userId: string): Promise<void> {
    const revoked = await UserE2eKeysRepository.revokeActive(this.pool, workspaceId, userId)
    if (revoked === 0) {
      throw new HttpError("No active E2E key to revoke", { status: 404, code: "E2E_KEY_NOT_FOUND" })
    }
  }
}
