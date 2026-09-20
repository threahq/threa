import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, type BotRuntimeFixture, botRuntimeServiceFor } from "./setup"

const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64")

describe("supervisor-held presence and the registered keys", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let bot: string

  async function heldKeyIds(): Promise<string[]> {
    const { rows } = await pool.query<{ key_id: string }>(
      `SELECT key_id FROM runtime_e2e_key_holders
       WHERE workspace_id = $1 AND bot_id = $2 AND instance_id = $3
       ORDER BY key_id`,
      [workspace, bot, "held-instance"]
    )
    return rows.map((row) => row.key_id)
  }

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "held_presence", instanceIds: ["held-instance"] })
    ;({ pool, workspace, bot } = fixture)
    await botRuntimeServiceFor(pool).upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "claude-code-channel",
      instanceId: "held-instance",
      status: "available",
      acceptingInvocations: true,
      capabilities: { sessionControl: true },
      publicKey: PUBLIC_KEY,
      publicKeyId: "bik_held1",
    })
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  test("held presence keeps the keys the session registered, so its sealed claims stay matchable", async () => {
    const held = await botRuntimeServiceFor(pool).upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "claude-code-channel",
      instanceId: "held-instance",
      status: "available",
      acceptingInvocations: true,
      capabilities: { sessionControl: true, supervisorHeld: true },
    })

    expect({
      publicKey: held.publicKey,
      publicKeyId: held.publicKeyId,
      status: held.status,
      keyIds: await heldKeyIds(),
    }).toEqual({
      publicKey: PUBLIC_KEY,
      publicKeyId: "bik_held1",
      status: "available",
      keyIds: ["bik_held1"],
    })
  })

  test("an ordinary keyless presence write still unregisters the keys", async () => {
    const plain = await botRuntimeServiceFor(pool).upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "claude-code-channel",
      instanceId: "held-instance",
      status: "available",
      acceptingInvocations: true,
      capabilities: { sessionControl: true },
    })

    expect({ publicKey: plain.publicKey, publicKeyId: plain.publicKeyId, keyIds: await heldKeyIds() }).toEqual({
      publicKey: null,
      publicKeyId: null,
      keyIds: [],
    })
  })
})
