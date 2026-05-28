import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { EnclaveRuntimesRepository } from "./repository"

const NOW = new Date("2026-05-28T12:00:00.000Z")

const ROW = {
  id: "elr_01",
  instance_id: "enci_01",
  key_id: "eik_01",
  public_key: Buffer.from([1, 2, 3]),
  instance_url: "https://enclave-1.internal:8443",
  registered_at: NOW,
  last_seen_at: NOW,
  revoked_at: null,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [ROW], rowCount?: number): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rowCount ?? rows.length } as QueryResult
    }),
  }
}

describe("EnclaveRuntimesRepository.registerKey", () => {
  afterEach(() => mock.restore())

  it("upserts on key_id conflict and maps the row to camelCase (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const result = await EnclaveRuntimesRepository.registerKey(db, {
      id: "elr_01",
      instanceId: "enci_01",
      keyId: "eik_01",
      publicKey: new Uint8Array([1, 2, 3]),
      instanceUrl: "https://enclave-1.internal:8443",
    })

    expect(captured.text).toContain("INSERT INTO enclave_runtimes")
    expect(captured.text).toContain("ON CONFLICT (key_id) DO UPDATE")
    expect(captured.text).toContain("RETURNING")
    expect(captured.values).toContain("elr_01")
    expect(captured.values).toContain("enci_01")
    expect(captured.values).toContain("eik_01")
    expect(captured.values).toContain("https://enclave-1.internal:8443")
    expect(result).toEqual({
      id: "elr_01",
      instanceId: "enci_01",
      keyId: "eik_01",
      publicKey: new Uint8Array([1, 2, 3]),
      instanceUrl: "https://enclave-1.internal:8443",
      registeredAt: NOW,
      lastSeenAt: NOW,
      revokedAt: null,
    })
  })

  it("passes the public key as a Buffer to the driver", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await EnclaveRuntimesRepository.registerKey(db, {
      id: "elr_01",
      instanceId: "enci_01",
      keyId: "eik_01",
      publicKey: new Uint8Array([1, 2, 3]),
      instanceUrl: "https://enclave-1.internal:8443",
    })

    const publicKeyValue = captured.values?.find((v) => Buffer.isBuffer(v)) as Buffer | undefined
    expect(publicKeyValue).toBeDefined()
    expect(Array.from(publicKeyValue!)).toEqual([1, 2, 3])
  })
})

describe("EnclaveRuntimesRepository.heartbeat", () => {
  afterEach(() => mock.restore())

  it("bumps last_seen_at only for a non-revoked row and reports a hit", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    const alive = await EnclaveRuntimesRepository.heartbeat(db, "eik_01")

    expect(captured.text).toContain("UPDATE enclave_runtimes")
    expect(captured.text).toContain("SET last_seen_at = NOW()")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.values).toEqual(["eik_01"])
    expect(alive).toBe(true)
  })

  it("reports a miss when no live row was updated", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const alive = await EnclaveRuntimesRepository.heartbeat(db, "eik_01")
    expect(alive).toBe(false)
  })
})

describe("EnclaveRuntimesRepository.listLive", () => {
  afterEach(() => mock.restore())

  it("filters to the live set within the staleness window and maps rows", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const result = await EnclaveRuntimesRepository.listLive(db, 120000)

    expect(captured.text).toContain("FROM enclave_runtimes")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.text).toContain("last_seen_at >")
    expect(captured.values).toContain(120000)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: "elr_01",
      instanceId: "enci_01",
      keyId: "eik_01",
      publicKey: new Uint8Array([1, 2, 3]),
      instanceUrl: "https://enclave-1.internal:8443",
      registeredAt: NOW,
      lastSeenAt: NOW,
      revokedAt: null,
    })
  })

  it("returns an empty list when nothing is live", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const result = await EnclaveRuntimesRepository.listLive(db, 120000)
    expect(result).toEqual([])
  })
})

describe("EnclaveRuntimesRepository.revoke", () => {
  afterEach(() => mock.restore())

  it("tombstones only a not-yet-revoked row (idempotent)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    await EnclaveRuntimesRepository.revoke(db, "eik_01")

    expect(captured.text).toContain("UPDATE enclave_runtimes")
    expect(captured.text).toContain("SET revoked_at = NOW()")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.values).toEqual(["eik_01"])
  })
})
