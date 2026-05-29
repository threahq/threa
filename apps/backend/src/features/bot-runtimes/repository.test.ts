import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { BotRuntimeInstanceRepository } from "./repository"

interface Captured {
  text: string | null
  values: unknown[] | null
}

// A complete row so `mapRuntimeInstance` (which asserts known runtime_kind +
// status) doesn't throw. The repo returns whatever the DB sends back; these
// tests assert on the SQL the repo builds, not on the round-trip.
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bri_1",
    workspace_id: "ws_1",
    bot_id: "bot_alice",
    runtime_kind: "pi-local",
    instance_id: "inst_42",
    display_name: null,
    status: "available",
    accepting_invocations: true,
    capabilities: {},
    status_text: null,
    public_key: null,
    public_key_id: null,
    last_seen_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

function createQuerier(captured: Captured, rows: unknown[]): Querier {
  return {
    query: mock(async (q) => {
      const config = q as QueryConfig
      captured.text = config.text
      captured.values = config.values ?? []
      return { rows, rowCount: rows.length } as QueryResult
    }),
  }
}

const BASE_PARAMS = {
  id: "bri_1",
  workspaceId: "ws_1",
  botId: "bot_alice",
  runtimeKind: "pi-local" as const,
  instanceId: "inst_42",
  status: "available" as const,
  acceptingInvocations: true,
  capabilities: {},
}

describe("BotRuntimeInstanceRepository.upsertPresence", () => {
  afterEach(() => mock.restore())

  it("persists a registered BIK and preserves it on conflict via COALESCE (INV-20)", async () => {
    const captured: Captured = { text: null, values: null }
    const publicKey = Buffer.alloc(32, 9).toString("base64")
    const row = makeRow({ public_key: publicKey, public_key_id: "bik_abc12" })
    const db = createQuerier(captured, [row])

    const result = await BotRuntimeInstanceRepository.upsertPresence(db, {
      ...BASE_PARAMS,
      publicKey,
      publicKeyId: "bik_abc12",
    })

    expect(captured.text).toContain("public_key")
    expect(captured.text).toContain("public_key_id")
    // A presence upsert that omits the key (touch / session-link path) must not
    // clobber a key an earlier session registered — only overwrite when present.
    expect(captured.text).toContain("public_key = COALESCE(EXCLUDED.public_key, bot_runtime_instances.public_key)")
    expect(captured.text).toContain(
      "public_key_id = COALESCE(EXCLUDED.public_key_id, bot_runtime_instances.public_key_id)"
    )
    expect(captured.values).toContain(publicKey)
    expect(captured.values).toContain("bik_abc12")
    expect(result.publicKey).toBe(publicKey)
    expect(result.publicKeyId).toBe("bik_abc12")
  })

  it("binds null BIK columns when no key is supplied", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow()])

    const result = await BotRuntimeInstanceRepository.upsertPresence(db, BASE_PARAMS)

    expect(captured.values).toContain(null)
    expect(result.publicKey).toBeNull()
    expect(result.publicKeyId).toBeNull()
  })

  it("keeps the COALESCE-preserve clause in the capabilities-merge branch too", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow()])

    await BotRuntimeInstanceRepository.upsertPresence(db, { ...BASE_PARAMS, mergeCapabilities: true })

    expect(captured.text).toContain("capabilities = bot_runtime_instances.capabilities || EXCLUDED.capabilities")
    expect(captured.text).toContain("public_key = COALESCE(EXCLUDED.public_key, bot_runtime_instances.public_key)")
  })
})
