import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, botRuntimeServiceFor, type BotRuntimeFixture } from "./setup"
import { BotChannelService } from "../../src/features/api-keys"
import { DecisionRequestRepository, DecisionService } from "../../src/features/decisions"
import { StreamEventRepository, StreamRepository } from "../../src/features/streams"
import { OutboxRepository } from "../../src/lib/outbox"
import { botChannelAccessId, streamId, userId } from "../../src/lib/id"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN } from "@threahq/types"

const OPTIONS = [
  { id: "yes", label: "Ship it", tone: "primary" as const },
  { id: "no", label: "Hold", tone: "neutral" as const },
]

describe("decision requests", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let stream: string
  let author: string
  let bot: string
  let service: DecisionService

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "decision_requests", instanceIds: ["hermes-instance"] })
    ;({ pool, workspace, stream, author, bot } = fixture)
    await pool.query("INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)", [stream, author])
    service = new DecisionService({ pool, botChannelService: new BotChannelService({ pool }) })
    await botRuntimeServiceFor(pool).createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "hermes",
      instanceId: "hermes-instance",
      runtimeSessionId: "hermes-session",
      rootStreamId: stream,
      activeStreamId: stream,
      linkedBy: author,
    })
  }, 30_000)

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  async function outboxSince(afterId: bigint) {
    return OutboxRepository.fetchAfterId(pool, afterId, 200)
  }

  async function outboxWatermark(): Promise<bigint> {
    const rows = await OutboxRepository.fetchAfterId(pool, 0n, 1000)
    return rows.length > 0 ? rows[rows.length - 1]!.id : 0n
  }

  function open(overrides: Partial<Parameters<DecisionService["request"]>[0]> = {}) {
    return service.request({
      workspaceId: workspace,
      streamId: stream,
      botId: bot,
      title: "Deploy the migration?",
      options: OPTIONS,
      allowNote: true,
      ...overrides,
    })
  }

  test("a running bot opens a card, a member resolves it, and both halves land on the timeline and the outbox", async () => {
    const watermark = await outboxWatermark()
    const decision = await open({ externalRef: "tool_call_7" })

    expect(decision).toMatchObject({
      workspaceId: workspace,
      streamId: stream,
      requesterBotId: bot,
      requesterRuntimeSessionId: "hermes-session",
      status: "open",
      allowNote: true,
      externalRef: "tool_call_7",
      options: OPTIONS,
      version: 1,
    })

    const requestedEvents = await StreamEventRepository.list(pool, stream, { types: ["decision:requested"] })
    expect(requestedEvents.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ decisionId: decision.id })
    )

    const resolved = await service.resolve({
      workspaceId: workspace,
      id: decision.id,
      userId: author,
      optionId: "yes",
      note: "green build",
      version: decision.version,
    })
    expect(resolved).toMatchObject({
      status: "resolved",
      version: 2,
      resolution: expect.objectContaining({ optionId: "yes", note: "green build", decidedBy: author }),
    })

    const patchEvents = await StreamEventRepository.list(pool, stream, { types: ["decision:resolved"] })
    expect(patchEvents.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ decisionId: decision.id, status: "resolved", version: 2 })
    )

    const emitted = await outboxSince(watermark)
    const byType = (type: string) =>
      emitted.filter((event) => event.eventType === type).map((event) => event.payload as Record<string, unknown>)
    expect(byType("stream:decision_requested")).toContainEqual(
      expect.objectContaining({ workspaceId: workspace, streamId: stream })
    )
    expect(byType("stream:decision_resolved")).toContainEqual(
      expect.objectContaining({ workspaceId: workspace, streamId: stream })
    )
    expect(byType("bot_decision:resolved")).toContainEqual({
      workspaceId: workspace,
      botId: bot,
      streamId: stream,
      runtimeSessionId: "hermes-session",
      decisionId: decision.id,
      status: "resolved",
      optionId: "yes",
      note: "green build",
      noteCiphertext: null,
      noteEnvelope: null,
      version: 2,
    })
  })

  test("only one of two racing resolvers wins; the loser is told the answer that landed", async () => {
    const decision = await open()
    const first = service.resolve({
      workspaceId: workspace,
      id: decision.id,
      userId: author,
      optionId: "yes",
      version: decision.version,
    })
    const second = service
      .resolve({
        workspaceId: workspace,
        id: decision.id,
        userId: author,
        optionId: "no",
        version: decision.version,
      })
      .catch((error: unknown) => error)

    const [winner, loser] = await Promise.all([first, second])
    expect(winner.status).toBe("resolved")
    expect(loser).toMatchObject({
      status: 409,
      code: "DECISION_NOT_OPEN",
      details: expect.objectContaining({ id: decision.id, status: "resolved", version: 2 }),
    })
  })

  test("a lapsed card expires in the sweep and the requester is pushed the expiry", async () => {
    const watermark = await outboxWatermark()
    const decision = await open({ expiresAt: new Date(Date.now() - 60_000) })

    const expired = await service.expireDue()
    expect(expired.map((row) => ({ id: row.id, status: row.status }))).toContainEqual({
      id: decision.id,
      status: "expired",
    })

    const emitted = await outboxSince(watermark)
    expect(
      emitted
        .filter((event) => event.eventType === "bot_decision:cancelled")
        .map((event) => event.payload as Record<string, unknown>)
    ).toContainEqual(expect.objectContaining({ decisionId: decision.id, status: "expired", version: 2 }))
    expect(await DecisionRequestRepository.findById(pool, workspace, decision.id)).toMatchObject({
      status: "expired",
    })
  })

  test("a sealed card and its sealed note round-trip through the columns, leaving no readable text", async () => {
    const watermark = await outboxWatermark()
    const sealedStream = streamId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'scratchpad', 'private', $3)",
      [sealedStream, workspace, author]
    )
    await pool.query("INSERT INTO stream_members (stream_id, member_id) VALUES ($1, $2)", [sealedStream, author])
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: workspace,
      botId: bot,
      streamId: sealedStream,
      grantedBy: author,
    })
    await pool.query(
      `INSERT INTO e2e_streams (stream_id, workspace_id, owner_user_id, owner_user_key_id, current_key_generation)
       VALUES ($1, $2, $3, 'e2ek_owner', 1)`,
      [sealedStream, workspace, author]
    )
    await botRuntimeServiceFor(pool).createOrLinkPiRemoteSession({
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "hermes",
      instanceId: "hermes-instance",
      runtimeSessionId: "hermes-sealed",
      rootStreamId: sealedStream,
      activeStreamId: sealedStream,
      linkedBy: author,
    })

    const minted = `dreq_${crypto.randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase()}`
    const envelope = { v: 2, keyGeneration: 1, iv: "aXZpdml2", aad: "YWFkYWFk" }
    const decision = await service.request({
      workspaceId: workspace,
      streamId: sealedStream,
      botId: bot,
      decisionId: minted,
      options: [
        { id: "yes", tone: "primary" as const },
        { id: "no", tone: "neutral" as const },
      ],
      sealed: { ciphertext: "c2VhbGVkLWNhcmQ=", envelope },
      allowNote: true,
    })

    expect(decision).toMatchObject({
      id: minted,
      streamId: sealedStream,
      title: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      bodyMarkdown: null,
      ciphertext: "c2VhbGVkLWNhcmQ=",
      envelope,
      options: [
        { id: "yes", label: E2E_PLACEHOLDER_CONTENT_MARKDOWN, tone: "primary" },
        { id: "no", label: E2E_PLACEHOLDER_CONTENT_MARKDOWN, tone: "neutral" },
      ],
    })

    // Minting the same id twice is a retry of a POST whose answer was lost.
    await expect(
      service.request({
        workspaceId: workspace,
        streamId: sealedStream,
        botId: bot,
        decisionId: minted,
        options: [{ id: "yes", tone: "primary" as const }],
        sealed: { ciphertext: "c2VhbGVkLWNhcmQ=", envelope },
        allowNote: false,
      })
    ).rejects.toMatchObject({ status: 409, code: "DECISION_ALREADY_EXISTS" })

    const resolved = await service.resolve({
      workspaceId: workspace,
      id: decision.id,
      userId: author,
      optionId: "yes",
      sealedNote: { ciphertext: "c2VhbGVkLW5vdGU=", envelope },
      version: decision.version,
    })
    expect(resolved.resolution).toMatchObject({
      optionId: "yes",
      noteCiphertext: "c2VhbGVkLW5vdGU=",
      noteEnvelope: envelope,
      decidedBy: author,
    })
    expect(resolved.resolution?.note).toBeUndefined()

    const reread = await DecisionRequestRepository.findById(pool, workspace, decision.id)
    expect(reread).toMatchObject({
      ciphertext: "c2VhbGVkLWNhcmQ=",
      envelope,
      status: "resolved",
      resolution: expect.objectContaining({ noteCiphertext: "c2VhbGVkLW5vdGU=" }),
    })

    expect(
      (await outboxSince(watermark))
        .filter((event) => event.eventType === "bot_decision:resolved")
        .map((event) => event.payload as Record<string, unknown>)
    ).toContainEqual(
      expect.objectContaining({
        decisionId: decision.id,
        note: null,
        noteCiphertext: "c2VhbGVkLW5vdGU=",
        noteEnvelope: envelope,
      })
    )
  })

  test("a personal bot's card in a public channel answers only to the bot's owner", async () => {
    const channel = streamId()
    const reader = userId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'public', $3)",
      [channel, workspace, author]
    )
    const decision = await DecisionRequestRepository.insert(pool, {
      id: `dreq_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`,
      workspaceId: workspace,
      streamId: channel,
      requesterBotId: bot,
      requesterRuntimeSessionId: "hermes-session",
      requesterInvocationId: null,
      title: "Run rm -rf build?",
      bodyMarkdown: null,
      options: OPTIONS,
      ciphertext: null,
      envelope: null,
      allowNote: false,
      externalRef: null,
      expiresAt: null,
    })
    const answer = (user: string) =>
      service.resolve({
        workspaceId: workspace,
        id: decision.id,
        userId: user,
        optionId: "yes",
        version: decision.version,
      })

    await expect(answer(reader)).rejects.toMatchObject({ status: 404, code: "DECISION_NOT_FOUND" })
    expect(await answer(author)).toMatchObject({
      status: "resolved",
      resolution: { optionId: "yes", decidedBy: author },
    })
  })

  test("a decision on a thread inside a channel is invisible to a non-member of the channel (INV-62)", async () => {
    const channel = streamId()
    const thread = streamId()
    const outsider = userId()
    await pool.query(
      "INSERT INTO streams (id, workspace_id, type, visibility, created_by) VALUES ($1, $2, 'channel', 'private', $3)",
      [channel, workspace, author]
    )
    await pool.query(
      `INSERT INTO streams (id, workspace_id, type, visibility, created_by, root_stream_id)
       VALUES ($1, $2, 'thread', 'private', $3, $4)`,
      [thread, workspace, author, channel]
    )
    expect(await StreamRepository.findByIdForWorkspace(pool, thread, workspace)).not.toBeNull()

    const decision = await DecisionRequestRepository.insert(pool, {
      id: `dreq_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`,
      workspaceId: workspace,
      streamId: thread,
      requesterBotId: bot,
      requesterRuntimeSessionId: "hermes-session",
      requesterInvocationId: null,
      title: "Merge?",
      bodyMarkdown: null,
      options: OPTIONS,
      ciphertext: null,
      envelope: null,
      allowNote: false,
      externalRef: null,
      expiresAt: null,
    })

    await expect(
      service.resolve({
        workspaceId: workspace,
        id: decision.id,
        userId: outsider,
        optionId: "yes",
        version: decision.version,
      })
    ).rejects.toMatchObject({ status: 404, code: "DECISION_NOT_FOUND" })
  })
})
