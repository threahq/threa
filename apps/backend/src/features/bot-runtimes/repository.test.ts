import { afterEach, describe, expect, it, mock } from "bun:test"
import type { QueryConfig, QueryResult } from "pg"
import type { Querier } from "../../db"
import { BOT_CLAIM_MAX_ATTEMPTS, BotInvocationRepository, BotRuntimeInstanceRepository } from "./repository"

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
    // BIK is per-session: a default presence write OVERWRITES it so a session
    // that registers no key can't leave a stale one live.
    expect(captured.text).toContain("public_key = EXCLUDED.public_key")
    expect(captured.text).toContain("public_key_id = EXCLUDED.public_key_id")
    expect(captured.text).not.toContain("public_key = COALESCE")
    expect(captured.values).toContain(publicKey)
    expect(captured.values).toContain("bik_abc12")
    expect(result.publicKey).toBe(publicKey)
    expect(result.publicKeyId).toBe("bik_abc12")
  })

  it("retains the existing BIK via COALESCE only when retainBik is set (touch / session-link)", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow()])

    await BotRuntimeInstanceRepository.upsertPresence(db, { ...BASE_PARAMS, retainBik: true })

    expect(captured.text).toContain("public_key = COALESCE(EXCLUDED.public_key, bot_runtime_instances.public_key)")
    expect(captured.text).toContain(
      "public_key_id = COALESCE(EXCLUDED.public_key_id, bot_runtime_instances.public_key_id)"
    )
  })

  it("binds null BIK columns when no key is supplied", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow()])

    const result = await BotRuntimeInstanceRepository.upsertPresence(db, BASE_PARAMS)

    expect(captured.values).toContain(null)
    expect(result.publicKey).toBeNull()
    expect(result.publicKeyId).toBeNull()
  })

  it("merges capabilities while still overwriting the BIK by default", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeRow()])

    await BotRuntimeInstanceRepository.upsertPresence(db, { ...BASE_PARAMS, mergeCapabilities: true })

    expect(captured.text).toContain("capabilities = bot_runtime_instances.capabilities || EXCLUDED.capabilities")
    expect(captured.text).toContain("public_key = EXCLUDED.public_key")
  })
})

describe("BotRuntimeInstanceRepository.findLiveWithKeyForBot", () => {
  afterEach(() => mock.restore())

  it("filters to live, keyed instances of the bot and maps the BIK columns", async () => {
    const captured: Captured = { text: null, values: null }
    const publicKey = Buffer.alloc(32, 5).toString("base64")
    const db = createQuerier(captured, [makeRow({ public_key: publicKey, public_key_id: "bik_live" })])

    const result = await BotRuntimeInstanceRepository.findLiveWithKeyForBot(db, {
      workspaceId: "ws_1",
      botId: "bot_alice",
      stalenessMs: 120_000,
    })

    expect(captured.text).toContain("public_key IS NOT NULL")
    expect(captured.text).toContain("public_key_id IS NOT NULL")
    expect(captured.text).toContain("status <> 'offline'")
    expect(captured.text).toContain("last_seen_at > NOW() -")
    expect(captured.values).toContain("ws_1")
    expect(captured.values).toContain("bot_alice")
    expect(captured.values).toContain(120_000)
    expect(result[0]?.publicKey).toBe(publicKey)
    expect(result[0]?.publicKeyId).toBe("bik_live")
  })
})

// A complete invocation row so `mapInvocation` (which asserts known
// actor_type/trigger/capability/status) doesn't throw.
function makeInvocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv_1",
    workspace_id: "ws_1",
    root_stream_id: "stream_root",
    active_stream_id: "stream_active",
    source_message_id: "msg_src",
    response_stream_id: "stream_resp",
    actor_type: "bot",
    actor_id: "bot_alice",
    trigger: "active-scratchpad",
    required_capability: "active-scratchpad",
    prompt_markdown: "do a thing",
    author_user_id: "usr_owner",
    mentioned_actor_slugs: [],
    status: "claimed",
    target_instance_id: null,
    target_runtime_session_id: null,
    claimed_by_instance_id: "inst_42",
    claim_token: "tok_1",
    claim_expires_at: new Date(),
    attempts: 1,
    error_message: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
    ...overrides,
  }
}

describe("BotInvocationRepository.claimOne", () => {
  afterEach(() => mock.restore())

  it("only claims invocations under the attempt budget and increments attempts", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeInvocationRow()])

    await BotInvocationRepository.claimOne(db, {
      workspaceId: "ws_1",
      botId: "bot_alice",
      instanceId: "inst_42",
      runtimeKind: "pi-local",
      claimToken: "tok_1",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
      maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
    })

    // Bounded re-claim: a wedged invocation can't be picked up forever.
    expect(captured.text).toContain("attempts < ")
    expect(captured.text).toContain("attempts = attempts + 1")
    expect(captured.values).toContain(BOT_CLAIM_MAX_ATTEMPTS)
  })
})

describe("BotInvocationRepository.parkExhausted", () => {
  afterEach(() => mock.restore())

  it("dead-letters expired claims at the attempt ceiling, preserving any reported error", async () => {
    const captured: Captured = { text: null, values: null }
    const db = createQuerier(captured, [makeInvocationRow({ status: "parked", attempts: BOT_CLAIM_MAX_ATTEMPTS })])

    const parked = await BotInvocationRepository.parkExhausted(db, {
      workspaceId: "ws_1",
      botId: "bot_alice",
      maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
    })

    expect(captured.text).toContain("status = 'parked'")
    expect(captured.text).toContain("claim_expires_at < NOW()")
    expect(captured.text).toContain("attempts >= ")
    // Keep the runtime's own failure message if it reported one.
    expect(captured.text).toContain("COALESCE(error_message,")
    expect(captured.values).toContain(BOT_CLAIM_MAX_ATTEMPTS)
    expect(parked[0]?.status).toBe("parked")
  })
})

describe("BotInvocationRepository.findBootstrapInvocations", () => {
  afterEach(() => mock.restore())

  it("excludes attempt-exhausted rows from the available list (mirrors claimOne)", async () => {
    // Two queries run via Promise.all (available + ownedClaims); capture every
    // text so the assertion targets the available query specifically.
    const texts: string[] = []
    const db: Querier = {
      query: mock(async (q) => {
        texts.push((q as QueryConfig).text)
        return { rows: [], rowCount: 0 } as unknown as QueryResult
      }),
    }

    await BotInvocationRepository.findBootstrapInvocations(db, {
      workspaceId: "ws_1",
      botId: "bot_alice",
      instanceId: "inst_42",
      runtimeSessionId: null,
      supportedCapabilities: ["active-scratchpad"],
      since: null,
      maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
    })

    const availableQuery = texts.find((t) => t.includes("attempts < "))
    expect(availableQuery).toBeDefined()
    // The owned-claims query must NOT be attempt-bounded: a runtime keeps its
    // own in-flight claim regardless of how many times it's been re-dispatched.
    const ownedClaimsQuery = texts.find((t) => t.includes("claimed_by_instance_id ="))
    expect(ownedClaimsQuery).toBeDefined()
    expect(ownedClaimsQuery).not.toContain("attempts < ")
  })
})
