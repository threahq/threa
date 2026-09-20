import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, type BotRuntimeFixture, botRuntimeServiceFor } from "./setup"
import { BotRuntimeInstanceRepository } from "../../src/features/bot-runtimes"
import { botRuntimeInstanceId } from "../../src/lib/id"

const PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64")

describe("supervisor-held presence and the BIK", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let bot: string

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "held_presence", instanceIds: ["held-instance"] })
    ;({ pool, workspace, bot } = fixture)
    await BotRuntimeInstanceRepository.upsertPresence(pool, {
      id: botRuntimeInstanceId(),
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

  test("held presence keeps the key the session registered, so its sealed claims stay matchable", async () => {
    const held = await botRuntimeServiceFor(pool).upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "claude-code-channel",
      instanceId: "held-instance",
      status: "available",
      acceptingInvocations: true,
      capabilities: { sessionControl: true, supervisorHeld: true },
    })

    expect({ publicKey: held.publicKey, publicKeyId: held.publicKeyId, status: held.status }).toEqual({
      publicKey: PUBLIC_KEY,
      publicKeyId: "bik_held1",
      status: "available",
    })
  })

  test("an ordinary keyless presence write still clears the key", async () => {
    const plain = await botRuntimeServiceFor(pool).upsertPresenceFromBotKey({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "claude-code-channel",
      instanceId: "held-instance",
      status: "available",
      acceptingInvocations: true,
      capabilities: { sessionControl: true },
    })

    expect({ publicKey: plain.publicKey, publicKeyId: plain.publicKeyId }).toEqual({
      publicKey: null,
      publicKeyId: null,
    })
  })
})
