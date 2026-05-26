import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { UserE2eKeysRepository, type KdfParams } from "./repository"

const NOW = new Date("2026-05-26T12:00:00.000Z")

const KDF_PARAMS: KdfParams = { algorithm: "argon2id", m: 65536, t: 3, p: 1, version: 19 }

const KEY_ROW = {
  id: "e2ek_01",
  user_id: "usr_1",
  workspace_id: "ws_1",
  key_id: "e2ek_01",
  public_key: Buffer.from([1, 2, 3]),
  encrypted_private_bundle: Buffer.from([9, 8, 7]),
  kdf_salt: Buffer.from([4, 5, 6]),
  kdf_params: KDF_PARAMS,
  created_at: NOW,
  revoked_at: null,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [KEY_ROW], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("UserE2eKeysRepository.getActiveByUser", () => {
  afterEach(() => mock.restore())

  it("filters by workspace, user, and revoked_at IS NULL (INV-8 + active scope)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const result = await UserE2eKeysRepository.getActiveByUser(db, "ws_1", "usr_1")

    expect(captured.text).toContain("FROM user_e2e_keys")
    expect(captured.text).toContain("workspace_id =")
    expect(captured.text).toContain("user_id =")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.values).toEqual(["ws_1", "usr_1"])
    expect(result?.keyId).toBe("e2ek_01")
    expect(result?.publicKey).toEqual(Buffer.from([1, 2, 3]))
  })

  it("returns null when no row found", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await UserE2eKeysRepository.getActiveByUser(db, "ws_1", "usr_1")
    expect(result).toBeNull()
  })
})

describe("UserE2eKeysRepository.getByKeyId", () => {
  afterEach(() => mock.restore())

  it("scopes lookup to workspace and matches on key_id", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await UserE2eKeysRepository.getByKeyId(db, "ws_1", "e2ek_01")

    expect(captured.text).toContain("key_id =")
    expect(captured.values).toEqual(["ws_1", "e2ek_01"])
  })
})

describe("UserE2eKeysRepository.insert", () => {
  afterEach(() => mock.restore())

  it("writes all bytea/jsonb fields and returns the inserted row", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const params = {
      id: "e2ek_01",
      userId: "usr_1",
      workspaceId: "ws_1",
      keyId: "e2ek_01",
      publicKey: Buffer.from([1, 2, 3]),
      encryptedPrivateBundle: Buffer.from([9, 8, 7]),
      kdfSalt: Buffer.from([4, 5, 6]),
      kdfParams: KDF_PARAMS,
    }

    const inserted = await UserE2eKeysRepository.insert(db, params)

    expect(captured.text).toContain("INSERT INTO user_e2e_keys")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain("e2ek_01")
    expect(captured.values).toContain("usr_1")
    expect(captured.values).toContain("ws_1")
    // kdfParams is serialized to JSON before binding
    expect(captured.values).toContain(JSON.stringify(KDF_PARAMS))
    expect(inserted.keyId).toBe("e2ek_01")
  })
})

describe("UserE2eKeysRepository.revokeActive", () => {
  afterEach(() => mock.restore())

  it("updates revoked_at and reports the affected row count", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    const count = await UserE2eKeysRepository.revokeActive(db, "ws_1", "usr_1")

    expect(captured.text).toContain("UPDATE user_e2e_keys")
    expect(captured.text).toContain("SET revoked_at = NOW()")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.values).toEqual(["ws_1", "usr_1"])
    expect(count).toBe(1)
  })

  it("returns 0 when no active key exists", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const count = await UserE2eKeysRepository.revokeActive(db, "ws_1", "usr_1")
    expect(count).toBe(0)
  })
})
