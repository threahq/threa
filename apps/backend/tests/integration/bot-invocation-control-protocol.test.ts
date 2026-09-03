import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { seedBotRuntimeFixture, testContentJson, type BotRuntimeFixture } from "./setup"
import { BotRuntimeService, BotRuntimeSessionLinkRepository } from "../../src/features/bot-runtimes"
import { withTransaction } from "../../src/db"
import { MessageRepository } from "../../src/features/messaging"
import { AgentSessionRepository, assertReplyKeyGeneration } from "../../src/features/agents"
import { BotChannelAccessRepository } from "../../src/features/api-keys"
import { BotRepository } from "../../src/features/public-api/bot-repository"
import { botChannelAccessId, messageId } from "../../src/lib/id"

describe("bot invocation control protocol", () => {
  let fixture: BotRuntimeFixture
  let pool: Pool
  let workspace: string
  let stream: string
  let author: string
  let bot: string
  const instance = `control-${crypto.randomUUID().slice(0, 8)}`
  const sibling = `${instance}-sibling`
  const service = () => new BotRuntimeService({ pool })

  beforeAll(async () => {
    fixture = await seedBotRuntimeFixture({ label: "invocation_control", instanceIds: [instance, sibling] })
    ;({ pool, workspace, stream, author, bot } = fixture)
  }, 30_000)

  beforeEach(async () => {
    await pool.query("DELETE FROM agent_sessions WHERE stream_id = $1", [stream])
    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM bot_runtime_session_links WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM messages WHERE stream_id = $1", [stream])
    await pool.query("DELETE FROM outbox WHERE payload->>'workspaceId' = $1", [workspace])
    await pool.query("UPDATE bot_runtime_instances SET manifest = NULL WHERE workspace_id = $1", [workspace])
    await service().setActiveActor({
      workspaceId: workspace,
      rootStreamId: stream,
      actorType: "bot",
      actorId: bot,
      createdBy: author,
    })
  })

  afterAll(async () => {
    await fixture?.cleanup()
  }, 30_000)

  async function createSource(markdown = "revision one") {
    const message = await MessageRepository.insert(pool, {
      id: messageId(),
      streamId: stream,
      sequence: BigInt(Date.now()),
      authorId: author,
      authorType: "user",
      contentJson: testContentJson(markdown),
      contentMarkdown: markdown,
    })
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: message.id })
    return message
  }

  async function setMode(mode: "live" | "restart" | null, id = instance) {
    await pool.query("UPDATE bot_runtime_instances SET manifest = $1 WHERE workspace_id = $2 AND instance_id = $3", [
      mode ? { output: {}, input: { updates: mode } } : null,
      workspace,
      id,
    ])
  }

  async function claim(token: string, id = instance, runtimeSessionId?: string) {
    return service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: id,
      runtimeSessionId,
      runtimeKind: "openclaw",
      claimToken: token,
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
  }

  async function edit(sourceId: string, revision: number) {
    await MessageRepository.updateContent(
      pool,
      sourceId,
      testContentJson(`revision ${revision}`),
      `revision ${revision}`
    )
    return service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: sourceId })
  }

  async function rows(sourceId: string) {
    return (
      await pool.query<{
        id: string
        status: string
        source_message_revision: number
        claimed_source_message_revision: number | null
        claimed_input_update_mode: string | null
        claim_token: string | null
      }>(
        `SELECT id, status, source_message_revision, claimed_source_message_revision,
                claimed_input_update_mode, claim_token
         FROM bot_invocations WHERE workspace_id = $1 AND source_message_id = $2
         ORDER BY created_at, id`,
        [workspace, sourceId]
      )
    ).rows
  }

  async function controlOutbox() {
    return (
      await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox
         WHERE payload->>'workspaceId' = $1
           AND event_type IN ('bot_invocation:available', 'bot_invocation:input_updated', 'bot_invocation:cancelled')
         ORDER BY id`,
        [workspace]
      )
    ).rows
  }

  test("reply generation transition updates only the running invocation session callback fence", async () => {
    await setMode("live")
    await createSource()
    const claimed = await claim("reply-generation")
    await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: claimed!.id,
      streamId: stream,
      personaId: bot,
      triggerMessageId: claimed!.sourceMessageId,
      triggerMessageRevision: claimed!.sourceMessageRevision,
      initialSequence: 0n,
      callbackTokenHash: "hash",
      replyKeyGeneration: 1,
    })

    const transitioned = await AgentSessionRepository.updateInvocationReplyKeyGeneration(pool, {
      workspaceId: workspace,
      invocationId: claimed!.id,
      replyKeyGeneration: 2,
    })
    const session = await AgentSessionRepository.findById(pool, claimed!.id)

    expect({ transitioned, generation: session?.replyKeyGeneration }).toEqual({ transitioned: true, generation: 2 })
    expect(() => assertReplyKeyGeneration(session!, { keyGeneration: 2 })).not.toThrow()
    expect(() => assertReplyKeyGeneration(session!, { keyGeneration: 1 })).toThrow()
  })

  test("claim ownership follows the actual runtime session across bootstrap, cancellation, and reclaim", async () => {
    const source = await createSource()
    const claimedByA = await claim("owner-a", instance, "session-a")
    const bootstrapA = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: "session-a",
      supportedCapabilities: ["active-scratchpad"],
    })
    const bootstrapB = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: "session-b",
      supportedCapabilities: ["active-scratchpad"],
    })
    await pool.query("UPDATE bot_invocations SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [
      claimedByA!.id,
    ])
    const reclaimedByB = await claim("owner-b", instance, "session-b")
    await MessageRepository.softDelete(pool, source.id)
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })
    const cancelledB = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: "session-b",
      supportedCapabilities: ["active-scratchpad"],
    })
    const cancelledA = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: "session-a",
      supportedCapabilities: ["active-scratchpad"],
    })
    const hints = (await controlOutbox()).filter((row) => row.event_type === "bot_invocation:cancelled")
    expect({
      ownedA: bootstrapA.ownedClaims.map((row) => row.id),
      ownedB: bootstrapB.ownedClaims.map((row) => row.id),
      reclaimedOwner: reclaimedByB!.claimedRuntimeSessionId,
      cancelledA: cancelledA.recentCancellations,
      cancelledB: cancelledB.recentCancellations.map((row) => row.targetRuntimeSessionId),
      hintTargets: hints.map((row) => row.payload.targetRuntimeSessionId),
    }).toEqual({
      ownedA: [claimedByA!.id],
      ownedB: [],
      reclaimedOwner: "session-b",
      cancelledA: [],
      cancelledB: ["session-b"],
      hintTargets: ["session-b"],
    })
  })

  test("sessionless claims are recovered only by sessionless bootstrap", async () => {
    const source = await createSource()
    const claimed = await claim("sessionless")
    const sessionless = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      supportedCapabilities: ["active-scratchpad"],
    })
    const named = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: "named",
      supportedCapabilities: ["active-scratchpad"],
    })
    expect({
      sourceId: source.id,
      sessionless: sessionless.ownedClaims.map((row) => row.id),
      named: named.ownedClaims,
    }).toEqual({
      sourceId: source.id,
      sessionless: [claimed!.id],
      named: [],
    })
  })

  test("claim pins absent, live, and restart manifests from the winner and ignores later changes", async () => {
    const result: Array<{ mode: string | null; pinned: string | null; after: string | null }> = []
    for (const mode of [null, "live", "restart"] as const) {
      await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
      await pool.query("DELETE FROM messages WHERE stream_id = $1", [stream])
      await setMode(mode)
      const source = await createSource(String(mode))
      const claimed = await claim(`manifest-${mode}`)
      await setMode(mode === "live" ? "restart" : "live")
      const persisted = (await rows(source.id))[0]!
      result.push({ mode, pinned: claimed!.claimedInputUpdateMode, after: persisted.claimed_input_update_mode })
    }
    expect(result).toEqual([
      { mode: null, pinned: null, after: null },
      { mode: "live", pinned: "live", after: "live" },
      { mode: "restart", pinned: "restart", after: "restart" },
    ])
  })

  test("explicit registration clears an omitted manifest while internal heartbeat retains it", async () => {
    const runtime = service()
    const base = {
      workspaceId: workspace,
      botId: bot,
      runtimeKind: "openclaw" as const,
      instanceId: instance,
      status: "available" as const,
      acceptingInvocations: true,
    }
    await runtime.upsertPresenceFromBotKey({
      ...base,
      manifest: { output: {}, input: { updates: "live" } },
    })
    const cleared = await runtime.upsertPresenceFromBotKey({ ...base, manifest: null })
    await runtime.upsertPresenceFromBotKey({
      ...base,
      manifest: { output: {}, input: { updates: "restart" } },
    })
    const retained = await runtime.upsertPresenceFromBotKey({ ...base, retainManifest: true })
    expect({ cleared: cleared.manifest, retained: retained.manifest }).toEqual({
      cleared: null,
      retained: { output: {}, input: { updates: "restart" } },
    })
  })

  test("live edits retain claim and emit exactly one highest-revision metadata hint", async () => {
    await setMode("live")
    const source = await createSource()
    const claimed = await claim("live-token")
    await edit(source.id, 2)
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })
    const persisted = (await rows(source.id))[0]!
    const hints = (await controlOutbox()).filter((row) => row.event_type === "bot_invocation:input_updated")
    expect({ persisted, hints }).toEqual({
      persisted: {
        id: claimed!.id,
        status: "claimed",
        source_message_revision: 2,
        claimed_source_message_revision: 1,
        claimed_input_update_mode: "live",
        claim_token: "live-token",
      },
      hints: [
        {
          event_type: "bot_invocation:input_updated",
          payload: {
            workspaceId: workspace,
            botId: bot,
            invocationId: claimed!.id,
            sourceRevision: 2,
            targetInstanceId: instance,
            targetRuntimeSessionId: null,
          },
        },
      ],
    })
  })

  test("restart edit atomically cancels predecessor and creates one current replacement", async () => {
    await setMode("restart")
    const source = await createSource()
    const claimed = await claim("restart-token")
    await edit(source.id, 2)
    const persisted = await rows(source.id)
    const events = (await controlOutbox()).filter((row) =>
      ["bot_invocation:cancelled", "bot_invocation:available"].includes(row.event_type)
    )
    expect({
      persisted,
      eventTypes: events.map((event) => event.event_type),
      cancelledRevision: events.at(-2)?.payload.sourceRevision,
    }).toEqual({
      persisted: [
        {
          id: claimed!.id,
          status: "cancelled",
          source_message_revision: 2,
          claimed_source_message_revision: 1,
          claimed_input_update_mode: "restart",
          claim_token: "restart-token",
        },
        expect.objectContaining({ status: "pending", source_message_revision: 2 }),
      ],
      eventTypes: ["bot_invocation:available", "bot_invocation:cancelled", "bot_invocation:available"],
      cancelledRevision: 2,
    })
  })

  test("legacy edit creates no immediate replacement; expiry reclaims latest prompt with fresh token and mode", async () => {
    const source = await createSource()
    const old = await claim("legacy-old")
    await edit(source.id, 2)
    expect(await rows(source.id)).toHaveLength(1)
    await pool.query("UPDATE bot_invocations SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [
      old!.id,
    ])
    await setMode("live")
    const fresh = await claim("legacy-fresh")
    expect({
      id: fresh?.id,
      prompt: fresh?.promptMarkdown,
      claimed: fresh?.claimedSourceMessageRevision,
      mode: fresh?.claimedInputUpdateMode,
      token: fresh?.claimToken,
    }).toEqual({
      id: old!.id,
      prompt: "revision 2",
      claimed: 2,
      mode: "live",
      token: "legacy-fresh",
    })
  })

  test("renew reconciles plaintext and sealed edits and deletions while the mutation listener is paused", async () => {
    await setMode("live")
    const results: Array<Record<string, unknown>> = []
    for (const delivery of ["plaintext", "sealed"] as const) {
      const source = await MessageRepository.insert(pool, {
        id: messageId(),
        streamId: stream,
        sequence: BigInt(Date.now()) + BigInt(results.length),
        authorId: author,
        authorType: "user",
        contentJson: testContentJson(delivery === "plaintext" ? "before" : ""),
        contentMarkdown: delivery === "plaintext" ? "before" : "",
        ...(delivery === "sealed"
          ? {
              ciphertext: Buffer.from("sealed-before"),
              envelope: { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" },
              e2eVersion: 2,
            }
          : {}),
      })
      await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })
      const token = `${delivery}-paused-listener`
      const claimed = await claim(token)
      if (delivery === "plaintext") {
        await MessageRepository.updateContent(pool, source.id, testContentJson("after"), "after")
      } else {
        await pool.query(
          `UPDATE messages
           SET ciphertext = $2, envelope = $3, edited_at = NOW(), revision = revision + 1
           WHERE id = $1`,
          [source.id, Buffer.from("sealed-after"), { v: 2, keyGeneration: 1, iv: "aXY=", aad: "YWFk" }]
        )
      }

      const edited = await service().renewInvocationClaim({
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: token,
        claimTtlSeconds: 60,
        knownSourceRevision: 1,
      })
      const deleted = await MessageRepository.softDelete(pool, source.id)
      const cancelled = await service().renewInvocationClaim({
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: token,
        claimTtlSeconds: 60,
        knownSourceRevision: 2,
      })
      results.push({
        delivery,
        editedStatus: edited?.status,
        editedRevision: edited?.sourceMessageRevision,
        deletedRevision: deleted?.revision,
        cancelledStatus: cancelled?.status,
        cancelledRevision: cancelled?.sourceMessageRevision,
        cancellationReason: cancelled?.cancellationReason,
      })
    }

    expect(results).toEqual(
      ["plaintext", "sealed"].map((delivery) => ({
        delivery,
        editedStatus: "claimed",
        editedRevision: 2,
        deletedRevision: 3,
        cancelledStatus: "cancelled",
        cancelledRevision: 3,
        cancellationReason: "source_deleted",
      }))
    )
  })

  test("deletion is recoverable through renew at the highest revision and scoped bootstrap cancellation", async () => {
    await setMode("live")
    const source = await createSource()
    const claimed = await claim("delete-token")
    const deleted = await MessageRepository.softDelete(pool, source.id)
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })
    await service().reconcileInvocationSource({ workspaceId: workspace, sourceMessageId: source.id })
    const renewed = await service().renewInvocationClaim({
      workspaceId: workspace,
      botId: bot,
      invocationId: claimed!.id,
      instanceId: instance,
      claimToken: "delete-token",
      claimTtlSeconds: 60,
      knownSourceRevision: 1,
    })
    const owner = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: null,
      supportedCapabilities: ["active-scratchpad"],
    })
    const other = await service().getBootstrapForRuntime({
      workspaceId: workspace,
      botId: bot,
      instanceId: sibling,
      runtimeSessionId: null,
      supportedCapabilities: ["active-scratchpad"],
    })
    const cancellationHints = (await controlOutbox()).filter((event) => event.event_type === "bot_invocation:cancelled")
    expect({
      renewed: renewed && {
        status: renewed.status,
        revision: renewed.sourceMessageRevision,
        reason: renewed.cancellationReason,
      },
      owner: owner.recentCancellations,
      other: other.recentCancellations,
      cancellationHints: cancellationHints.length,
    }).toEqual({
      renewed: { status: "cancelled", revision: deleted!.revision, reason: "source_deleted" },
      owner: [
        {
          invocationId: claimed!.id,
          sourceRevision: deleted!.revision,
          reason: "source_deleted",
          targetInstanceId: instance,
          targetRuntimeSessionId: null,
        },
      ],
      other: [],
      cancellationHints: 1,
    })
  })

  test("live plaintext and callback-token completions commit the exact applied revision", async () => {
    for (const sealedCallback of [false, true]) {
      await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
      await pool.query("DELETE FROM messages WHERE stream_id = $1", [stream])
      await setMode("live")
      const source = await createSource()
      const token = sealedCallback ? "sealed-live" : "plaintext-live"
      const claimed = await claim(token)
      await edit(source.id, 2)
      const completed = sealedCallback
        ? await withTransaction(pool, async (db) => {
            const locked = await service().findActiveClaimForUpdate(db, {
              workspaceId: workspace,
              botId: bot,
              invocationId: claimed!.id,
              claimToken: token,
            })
            expect(await service().validateClaimSourceForCompletion(db, locked!, 2)).toBe(true)
            return service().completeInvocationInTransaction(db, {
              workspaceId: workspace,
              botId: bot,
              invocationId: claimed!.id,
              claimToken: token,
              sourceRevision: 2,
            })
          })
        : await service().completeInvocation({
            workspaceId: workspace,
            botId: bot,
            invocationId: claimed!.id,
            instanceId: instance,
            claimToken: token,
            sourceRevision: 2,
          })
      expect({ sealedCallback, status: completed?.status, revision: completed?.sourceMessageRevision }).toEqual({
        sealedCallback,
        status: "completed",
        revision: 2,
      })
    }
  })

  test("renew cancels route drift without waiting for a source revision", async () => {
    const link = (runtimeSessionId: string) =>
      BotRuntimeSessionLinkRepository.upsert(pool, {
        id: `brsl_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId: workspace,
        botId: bot,
        runtimeKind: "openclaw",
        instanceId: instance,
        runtimeSessionId,
        rootStreamId: stream,
        activeStreamId: stream,
        linkedBy: author,
      })
    await link("session-a")
    const source = await createSource("route A")
    const claimed = await claim("route-drift-token", instance, "session-a")
    await link("session-b")

    const renewed = await service().renewInvocationClaim({
      workspaceId: workspace,
      botId: bot,
      invocationId: claimed!.id,
      instanceId: instance,
      claimToken: "route-drift-token",
      claimTtlSeconds: 60,
      knownSourceRevision: source.revision,
    })
    const persisted = await pool.query<{ status: string; target_runtime_session_id: string }>(
      `SELECT status, target_runtime_session_id
       FROM bot_invocations WHERE source_message_id = $1 ORDER BY created_at, id`,
      [source.id]
    )
    expect({ status: renewed?.status, reason: renewed?.cancellationReason, rows: persisted.rows }).toEqual({
      status: "cancelled",
      reason: "routing_changed",
      rows: [
        { status: "cancelled", target_runtime_session_id: "session-a" },
        { status: "pending", target_runtime_session_id: "session-b" },
      ],
    })
  })

  test("pending and claimed routes retarget to the current runtime session", async () => {
    const link = async (runtimeSessionId: string) =>
      BotRuntimeSessionLinkRepository.upsert(pool, {
        id: `brsl_${crypto.randomUUID().replaceAll("-", "")}`,
        workspaceId: workspace,
        botId: bot,
        runtimeKind: "openclaw",
        instanceId: instance,
        runtimeSessionId,
        rootStreamId: stream,
        activeStreamId: stream,
        linkedBy: author,
      })

    await link("session-a")
    const pendingSource = await createSource("pending A")
    const pendingBefore = (await rows(pendingSource.id))[0]!
    await link("session-b")
    await edit(pendingSource.id, 2)
    const pendingAfter = (
      await pool.query<{ id: string; target_runtime_session_id: string }>(
        "SELECT id, target_runtime_session_id FROM bot_invocations WHERE source_message_id = $1 AND status = 'pending'",
        [pendingSource.id]
      )
    ).rows[0]
    const pendingHints = (await controlOutbox()).filter(
      (event) => event.event_type === "bot_invocation:available" && event.payload.invocationId === pendingBefore.id
    )
    expect({ pendingAfter, hintTargets: pendingHints.map((event) => event.payload.targetRuntimeSessionId) }).toEqual({
      pendingAfter: { id: pendingBefore.id, target_runtime_session_id: "session-b" },
      hintTargets: ["session-a", "session-b"],
    })

    await pool.query("DELETE FROM bot_invocations WHERE workspace_id = $1", [workspace])
    await pool.query("DELETE FROM messages WHERE stream_id = $1", [stream])
    await pool.query("DELETE FROM outbox WHERE payload->>'workspaceId' = $1", [workspace])
    await link("session-a")
    const claimedSource = await createSource("claimed A")
    const claimed = await service().claimNextInvocation({
      workspaceId: workspace,
      botId: bot,
      instanceId: instance,
      runtimeSessionId: "session-a",
      runtimeKind: "openclaw",
      claimToken: "retarget-token",
      supportedCapabilities: ["active-scratchpad"],
      claimTtlSeconds: 60,
    })
    await link("session-b")
    await edit(claimedSource.id, 2)
    const retargeted = await pool.query<{ id: string; status: string; target_runtime_session_id: string }>(
      "SELECT id, status, target_runtime_session_id FROM bot_invocations WHERE source_message_id = $1 ORDER BY created_at, id",
      [claimedSource.id]
    )
    expect(retargeted.rows).toEqual([
      { id: claimed!.id, status: "cancelled", target_runtime_session_id: "session-a" },
      expect.objectContaining({ status: "pending", target_runtime_session_id: "session-b" }),
    ])
  })

  test("stale completion reconciles all current actors before returning conflict", async () => {
    const replacementBot = `bot_${crypto.randomUUID().slice(0, 8)}`
    await BotRepository.create(pool, {
      id: replacementBot,
      workspaceId: workspace,
      type: "personal",
      ownerUserId: author,
      traits: ["active-scratchpad"],
      slug: `replacement-${crypto.randomUUID().slice(0, 8)}`,
      name: "Replacement bot",
    })
    await pool.query(
      `INSERT INTO bot_runtime_instances
         (id, workspace_id, bot_id, instance_id, runtime_kind, status, accepting_invocations, manifest)
       VALUES ($1, $2, $3, $4, 'openclaw', 'available', TRUE, NULL)`,
      [`bri_${crypto.randomUUID().replaceAll("-", "")}`, workspace, replacementBot, `${instance}-replacement`]
    )
    await BotChannelAccessRepository.grantAccess(pool, {
      id: botChannelAccessId(),
      workspaceId: workspace,
      botId: replacementBot,
      streamId: stream,
      grantedBy: author,
    })
    const source = await createSource()
    const claimed = await claim("stale-route-token")
    await MessageRepository.updateContent(pool, source.id, testContentJson("revision 2"), "revision 2")
    await service().setActiveActor({
      workspaceId: workspace,
      rootStreamId: stream,
      actorType: "bot",
      actorId: replacementBot,
      createdBy: author,
    })
    await withTransaction(pool, async (db) => {
      const locked = await service().findActiveClaimForUpdate(db, {
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "stale-route-token",
      })
      expect(await service().validateClaimSourceForCompletion(db, locked!, 1)).toBe(false)
      await service().reconcileStaleCompletionInTransaction(db, locked!)
    })
    const corrected = await pool.query<{
      actor_id: string
      status: string
      source_message_revision: number
      cancellation_reason: string | null
    }>(
      "SELECT actor_id, status, source_message_revision, cancellation_reason FROM bot_invocations WHERE source_message_id = $1 ORDER BY created_at, id",
      [source.id]
    )
    expect(corrected.rows).toEqual([
      { actor_id: bot, status: "cancelled", source_message_revision: 2, cancellation_reason: "input_stale" },
      { actor_id: replacementBot, status: "pending", source_message_revision: 2, cancellation_reason: null },
    ])
  })

  test("startup repair terminalizes historical migration cancellations without a new control hint", async () => {
    const source = await createSource()
    const claimed = await claim("repair-token")
    await AgentSessionRepository.insert(pool, {
      id: claimed!.id,
      streamId: stream,
      personaId: bot,
      triggerMessageId: source.id,
      status: "running",
    })
    await pool.query(
      "UPDATE bot_invocations SET status = 'cancelled', cancellation_reason = 'source_deleted' WHERE id = $1",
      [claimed!.id]
    )
    const before = (await controlOutbox()).filter((event) => event.event_type === "bot_invocation:cancelled").length

    expect(await service().repairDeletedSourceSession({ workspaceId: workspace, sessionId: claimed!.id })).toBe(true)

    const session = await AgentSessionRepository.findById(pool, claimed!.id)
    const after = (await controlOutbox()).filter((event) => event.event_type === "bot_invocation:cancelled").length
    expect({ status: session?.status, newCancellationHints: after - before }).toEqual({
      status: "deleted",
      newCancellationHints: 0,
    })
  })

  test("restartRequiredRevision rejects invalid generations and performs one valid replacement", async () => {
    await setMode("live")
    const source = await createSource()
    const claimed = await claim("adapter-token")
    await edit(source.id, 2)
    const base = {
      workspaceId: workspace,
      botId: bot,
      invocationId: claimed!.id,
      instanceId: instance,
      claimToken: "adapter-token",
      claimTtlSeconds: 60,
    }
    expect([
      await service().renewInvocationClaim({ ...base, knownSourceRevision: 3 }),
      await service().renewInvocationClaim({ ...base, knownSourceRevision: 1, restartRequiredRevision: 2 }),
      await service().renewInvocationClaim({ ...base, knownSourceRevision: 2, restartRequiredRevision: 1 }),
      await service().renewInvocationClaim({
        ...base,
        instanceId: sibling,
        knownSourceRevision: 2,
        restartRequiredRevision: 2,
      }),
    ]).toEqual([null, null, null, null])
    const cancelled = await service().renewInvocationClaim({
      ...base,
      knownSourceRevision: 2,
      restartRequiredRevision: 2,
    })
    expect({
      cancelled: cancelled && { status: cancelled.status, reason: cancelled.cancellationReason },
      rows: await rows(source.id),
      events: (await controlOutbox())
        .filter((e) => e.event_type !== "bot_invocation:input_updated")
        .map((e) => e.event_type),
    }).toEqual({
      cancelled: { status: "cancelled", reason: "adapter_restart_required" },
      rows: [
        expect.objectContaining({ status: "cancelled" }),
        expect.objectContaining({ status: "pending", source_message_revision: 2 }),
      ],
      events: ["bot_invocation:available", "bot_invocation:cancelled", "bot_invocation:available"],
    })
  })

  test("renew serialized behind cancellation cannot extend a cancelled claim", async () => {
    const source = await createSource()
    const claimed = await claim("race-token")
    const blocker = await pool.connect()
    await blocker.query("BEGIN")
    try {
      await blocker.query("SELECT id FROM bot_invocations WHERE id = $1 FOR UPDATE", [claimed!.id])
      let settled = false
      const renewing = service()
        .renewInvocationClaim({
          workspaceId: workspace,
          botId: bot,
          invocationId: claimed!.id,
          instanceId: instance,
          claimToken: "race-token",
          claimTtlSeconds: 600,
          knownSourceRevision: 1,
        })
        .finally(() => {
          settled = true
        })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(settled).toBe(false)
      await blocker.query(
        "UPDATE bot_invocations SET status = 'cancelled', cancellation_reason = 'routing_changed' WHERE id = $1",
        [claimed!.id]
      )
      await blocker.query("COMMIT")
      expect((await renewing)?.status).toBe("cancelled")
      const persisted = await pool.query<{ status: string; extended: boolean }>(
        "SELECT status, claim_expires_at > NOW() + INTERVAL '5 minutes' AS extended FROM bot_invocations WHERE id = $1",
        [claimed!.id]
      )
      expect({ sourceRevision: source.revision, persisted: persisted.rows[0] }).toEqual({
        sourceRevision: 1,
        persisted: { status: "cancelled", extended: false },
      })
    } finally {
      await blocker.query("ROLLBACK").catch(() => {})
      blocker.release()
    }
  })

  test("renew and edit reconciliation follow source-before-row lock order", async () => {
    const source = await createSource()
    const claimed = await claim("lock-order-token")
    await MessageRepository.updateContent(pool, source.id, testContentJson("revision 2"), "revision 2")
    const blocker = await pool.connect()
    await blocker.query("BEGIN")
    try {
      await blocker.query("SELECT id FROM bot_invocations WHERE id = $1 FOR UPDATE", [claimed!.id])
      const renewing = service().renewInvocationClaim({
        workspaceId: workspace,
        botId: bot,
        invocationId: claimed!.id,
        instanceId: instance,
        claimToken: "lock-order-token",
        claimTtlSeconds: 60,
        knownSourceRevision: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      const reconciling = service().reconcileInvocationSource({
        workspaceId: workspace,
        sourceMessageId: source.id,
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      await blocker.query("COMMIT")
      const settled = await Promise.race([
        Promise.all([renewing, reconciling]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lock-order race timed out")), 2_000)),
      ])
      expect({ renewed: settled[0]?.status, revision: (await rows(source.id))[0]?.source_message_revision }).toEqual({
        renewed: "claimed",
        revision: 2,
      })
    } finally {
      await blocker.query("ROLLBACK").catch(() => {})
      blocker.release()
    }
  })
})
