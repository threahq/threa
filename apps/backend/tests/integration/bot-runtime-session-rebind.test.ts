import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, type BotRuntimeFixture, botRuntimeServiceFor } from "./setup"
import { BotRuntimeInstanceRepository } from "../../src/features/bot-runtimes"
import { botRuntimeInstanceId } from "../../src/lib/id"

describe("rebinding a bot runtime session to a new instance", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let root: string
  let author: string
  let bot: string

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "session_rebind", instanceIds: ["old-instance"] })
    ;({ pool, workspace, stream: root, author, bot } = fixture)
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  test("a non-Pi link rebinds and keeps the capabilities the new instance advertised", async () => {
    const service = botRuntimeServiceFor(pool)
    const link = await service.createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "hermes",
      instanceId: "old-instance",
      runtimeSessionId: "hermes-session",
      rootStreamId: root,
      activeStreamId: root,
      linkedBy: author,
    })

    // The connector reconnects under a fresh instance id and advertises its
    // own capability set in bot:hello before it rebinds the link.
    await BotRuntimeInstanceRepository.upsertPresence(pool, {
      id: botRuntimeInstanceId(),
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "hermes",
      instanceId: "new-instance",
      status: "available",
      acceptingInvocations: true,
      capabilities: { runtimeSessionId: "hermes-session", supportsSteer: true },
    })

    const rebound = await service.rebindPiRemoteSessionInstance({
      workspaceId: workspace,
      botId: bot,
      linkId: link.id,
      instanceId: "old-instance",
      runtimeSessionId: "hermes-session",
      newInstanceId: "new-instance",
    })
    expect(rebound).toMatchObject({ id: link.id, runtimeKind: "hermes", instanceId: "new-instance", status: "active" })

    const presence = await BotRuntimeInstanceRepository.findByInstance(pool, {
      workspaceId: workspace,
      botId: bot,
      instanceId: "new-instance",
    })
    expect(presence).toMatchObject({
      runtimeKind: "hermes",
      capabilities: {
        runtimeSessionId: "hermes-session",
        supportsSteer: true,
        supportsActiveScratchpad: true,
        supportsPersistentSessions: true,
      },
    })
    expect(presence?.capabilities).not.toHaveProperty("sessionControlCommands")
  })
})
