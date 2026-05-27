import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { EnclaveRuntimesRepository } from "./repository"

const NOW = new Date("2026-05-27T12:00:00.000Z")

const RUNTIME_ROW = {
  id: "elr_1",
  instance_id: "enci_a",
  key_id: "eik_a",
  public_key: Buffer.from([0xaa, 0xbb, 0xcc]),
  instance_url: "http://enclave-a.local:3011",
  registered_at: NOW,
  last_seen_at: NOW,
  revoked_at: null,
}

interface Captured {
  text: string | null
  values: unknown[] | null
}

function createQuerier(captured: Captured, rows: unknown[] = [RUNTIME_ROW], rowCount?: number): Querier {
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

  it("inserts with ON CONFLICT (key_id) DO UPDATE for race-safe re-registration (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await EnclaveRuntimesRepository.registerKey(db, {
      id: "elr_new",
      instanceId: "enci_a",
      keyId: "eik_a",
      publicKey: new Uint8Array([0xaa, 0xbb, 0xcc]),
      instanceUrl: "http://enclave-a.local:3011",
    })

    expect(captured.text).toContain("INSERT INTO enclave_runtimes")
    expect(captured.text).toContain("ON CONFLICT (key_id) DO UPDATE")
    expect(captured.text).toContain("instance_url = EXCLUDED.instance_url")
    expect(captured.text).toContain("last_seen_at = NOW()")
    expect(captured.text).toContain("revoked_at = NULL")
    expect(captured.values).toContain("elr_new")
    expect(captured.values).toContain("enci_a")
    expect(captured.values).toContain("eik_a")
    expect(captured.values).toContain("http://enclave-a.local:3011")
  })

  it("maps Buffer public_key back into Uint8Array on the returned row", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    const result = await EnclaveRuntimesRepository.registerKey(db, {
      id: "elr_new",
      instanceId: "enci_a",
      keyId: "eik_a",
      publicKey: new Uint8Array([0xaa, 0xbb, 0xcc]),
      instanceUrl: "http://enclave-a.local:3011",
    })

    expect(result.publicKey).toBeInstanceOf(Uint8Array)
    expect(Array.from(result.publicKey)).toEqual([0xaa, 0xbb, 0xcc])
  })
})

describe("EnclaveRuntimesRepository.heartbeat", () => {
  afterEach(() => mock.restore())

  it("updates last_seen_at only on rows where revoked_at IS NULL (no tombstone resurrection)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    const updated = await EnclaveRuntimesRepository.heartbeat(db, "eik_a")

    expect(captured.text).toContain("UPDATE enclave_runtimes")
    expect(captured.text).toContain("SET last_seen_at = NOW()")
    expect(captured.text).toContain("key_id =")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.values).toContain("eik_a")
    expect(updated).toBe(true)
  })

  it("returns false when no live row exists", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 0)

    const updated = await EnclaveRuntimesRepository.heartbeat(db, "eik_dead")

    expect(updated).toBe(false)
  })
})

describe("EnclaveRuntimesRepository.listLive", () => {
  afterEach(() => mock.restore())

  it("filters to non-revoked rows within the staleness window, ordered last_seen_at DESC", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured)

    await EnclaveRuntimesRepository.listLive(db, 120_000)

    expect(captured.text).toContain("FROM enclave_runtimes")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.text).toContain("last_seen_at > NOW() - (")
    expect(captured.text).toContain("INTERVAL '1 millisecond'")
    expect(captured.text).toContain("ORDER BY last_seen_at DESC")
    expect(captured.values).toContain(120_000)
  })

  it("maps each row's public_key into a Uint8Array", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [RUNTIME_ROW, { ...RUNTIME_ROW, id: "elr_2", key_id: "eik_b" }])

    const result = await EnclaveRuntimesRepository.listLive(db, 120_000)

    expect(result).toHaveLength(2)
    expect(result[0]!.publicKey).toBeInstanceOf(Uint8Array)
    expect(result[1]!.keyId).toBe("eik_b")
  })
})

describe("EnclaveRuntimesRepository.revoke", () => {
  afterEach(() => mock.restore())

  it("only updates rows where revoked_at IS NULL (idempotent)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [], 1)

    await EnclaveRuntimesRepository.revoke(db, "eik_a")

    expect(captured.text).toContain("UPDATE enclave_runtimes")
    expect(captured.text).toContain("SET revoked_at = NOW()")
    expect(captured.text).toContain("key_id =")
    expect(captured.text).toContain("revoked_at IS NULL")
    expect(captured.values).toContain("eik_a")
  })
})
