import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import { Pool } from "pg"
import { addTestMember, setupIsolatedTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { EventService } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { botChannelAccessId, botInvocationId, streamId, userId, workspaceId } from "../../src/lib/id"
import { AgentSessionStatuses, AuthorTypes, BotInvocationCapabilities, BotInvocationTriggers } from "@threahq/types"
import { AgentSessionRepository } from "../../src/features/agents"
import { BotChannelAccessRepository, BotChannelService } from "../../src/features/api-keys"
import { BotInvocationRepository, BotRuntimeService } from "../../src/features/bot-runtimes"
import { createPublicApiHandlers, type PublicApiDeps } from "../../src/features/public-api/handlers"

interface Fixture {
  target: string
  botId: string
  invocationId: string
  instanceId: string
  claimToken: string
}

describe("failBotInvocation ends the agent session", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let workspace: string
  let member: string
  const emitted: Array<{ room: string; event: string; payload: unknown }> = []

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("bot_invocation_fail_ends_session")
    pool = isolated.pool
    cleanup = isolated.cleanup
    workspace = workspaceId()
    member = userId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, { id: workspace, name: "Fail", slug: workspace, createdBy: member })
      member = (await addTestMember(client, workspace, member)).id
    })
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedClaim(session: "running" | "completed" | "none"): Promise<Fixture> {
    const target = streamId()
    const botId = `bot_fail_${crypto.randomUUID()}`
    const invocationId = botInvocationId()
    const instanceId = `instance_${crypto.randomUUID()}`
    const claimToken = `claim_${crypto.randomUUID()}`

    await withTransaction(pool, async (client) => {
      await StreamRepository.insert(client, {
        id: target,
        workspaceId: workspace,
        type: "channel",
        visibility: "private",
        companionMode: "off",
        createdBy: member,
      })
      await StreamMemberRepository.insert(client, target, member)
      await client.query("INSERT INTO bots (id, workspace_id, api_key_id, name) VALUES ($1,$2,$3,$4)", [
        botId,
        workspace,
        `key_${crypto.randomUUID()}`,
        "Fail bot",
      ])
      await BotChannelAccessRepository.grantAccess(client, {
        id: botChannelAccessId(),
        workspaceId: workspace,
        botId,
        streamId: target,
        grantedBy: member,
      })
    })

    const trigger = (
      await new EventService(pool).createMessageForPrincipalReturningConversation(
        { kind: "user", userId: member },
        {
          workspaceId: workspace,
          streamId: target,
          authorId: member,
          authorType: AuthorTypes.USER,
          contentJson: { type: "doc", content: [] },
          contentMarkdown: "invoke",
        }
      )
    ).message

    await withTransaction(pool, async (client) => {
      await BotInvocationRepository.insertIdempotent(client, {
        id: invocationId,
        workspaceId: workspace,
        rootStreamId: target,
        activeStreamId: target,
        sourceMessageId: trigger.id,
        responseStreamId: target,
        actorType: AuthorTypes.BOT,
        actorId: botId,
        trigger: BotInvocationTriggers.MENTION,
        requiredCapability: BotInvocationCapabilities.MENTIONABLE,
        promptMarkdown: "invoke",
        authorUserId: member,
        mentionedActorSlugs: [],
        targetInstanceId: null,
        targetRuntimeSessionId: null,
        metadata: {},
        sourceMessageRevision: trigger.revision,
      })
      await client.query(
        "UPDATE bot_invocations SET status='claimed', claimed_by_instance_id=$2, claim_token=$3, claim_expires_at=NOW()+INTERVAL '5 minutes', claimed_source_message_revision=source_message_revision WHERE id=$1",
        [invocationId, instanceId, claimToken]
      )
      if (session !== "none") {
        await AgentSessionRepository.insert(client, {
          id: invocationId,
          streamId: target,
          personaId: botId,
          triggerMessageId: trigger.id,
          status: session === "running" ? AgentSessionStatuses.RUNNING : AgentSessionStatuses.COMPLETED,
        })
      }
    })

    return { target, botId, invocationId, instanceId, claimToken }
  }

  function handlers() {
    const io = {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ room, event, payload })
        },
      }),
    } as unknown as PublicApiDeps["io"]
    return createPublicApiHandlers({
      pool,
      io,
      eventService: new EventService(pool),
      streamService: new StreamService(pool),
      botRuntimeService: new BotRuntimeService({ pool }),
      botChannelService: new BotChannelService({ pool }),
      searchService: {} as PublicApiDeps["searchService"],
      memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
      attachmentService: {} as PublicApiDeps["attachmentService"],
      labelService: {} as PublicApiDeps["labelService"],
      labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    })
  }

  async function fail(fixture: Fixture, errorMessage: string): Promise<unknown> {
    const payloads: unknown[] = []
    const res = {} as Response
    res.status = (() => res) as Response["status"]
    res.json = ((payload: unknown) => {
      payloads.push(payload)
      return res
    }) as Response["json"]
    await handlers().failBotInvocation(
      {
        workspaceId: workspace,
        params: { invocationId: fixture.invocationId },
        botApiKey: { botId: fixture.botId },
        body: { instanceId: fixture.instanceId, claimToken: fixture.claimToken, errorMessage },
      } as unknown as Request,
      res
    )
    return payloads[0]
  }

  async function state(fixture: Fixture) {
    const invocation = await pool.query("SELECT status, error_message FROM bot_invocations WHERE id=$1", [
      fixture.invocationId,
    ])
    const session = await pool.query("SELECT status, error FROM agent_sessions WHERE id=$1", [fixture.invocationId])
    const events = await pool.query(
      "SELECT payload->>'sessionId' AS session_id, payload->>'error' AS error FROM stream_events WHERE stream_id=$1 AND event_type='agent_session:failed'",
      [fixture.target]
    )
    return { invocation: invocation.rows[0], session: session.rows[0] ?? null, failedEvents: events.rows }
  }

  test("should fail the running session with the runtime's error", async () => {
    const fixture = await seedClaim("running")

    const response = await fail(fixture, "provider exploded")

    expect(response).toEqual({ data: { invocationId: fixture.invocationId, status: "failed" } })
    expect(await state(fixture)).toEqual({
      invocation: { status: "failed", error_message: "provider exploded" },
      session: { status: AgentSessionStatuses.FAILED, error: "provider exploded" },
      failedEvents: [{ session_id: fixture.invocationId, error: "provider exploded" }],
    })
    expect(emitted).toContainEqual({
      room: `ws:${workspace}:agent_session:${fixture.invocationId}`,
      event: "agent_session:failed",
      payload: { sessionId: fixture.invocationId },
    })
  })

  test("should leave the session untouched on a second fail", async () => {
    const fixture = await seedClaim("running")
    await fail(fixture, "provider exploded")

    await expect(fail(fixture, "second failure")).rejects.toMatchObject({ status: 404 })

    expect(await state(fixture)).toEqual({
      invocation: { status: "failed", error_message: "provider exploded" },
      session: { status: AgentSessionStatuses.FAILED, error: "provider exploded" },
      failedEvents: [{ session_id: fixture.invocationId, error: "provider exploded" }],
    })
  })

  test("should fail an invocation that has no session", async () => {
    const fixture = await seedClaim("none")

    const response = await fail(fixture, "provider exploded")

    expect(response).toEqual({ data: { invocationId: fixture.invocationId, status: "failed" } })
    expect(await state(fixture)).toEqual({
      invocation: { status: "failed", error_message: "provider exploded" },
      session: null,
      failedEvents: [],
    })
  })

  test("should leave a completed session completed", async () => {
    const fixture = await seedClaim("completed")

    await fail(fixture, "provider exploded")

    expect(await state(fixture)).toEqual({
      invocation: { status: "failed", error_message: "provider exploded" },
      session: { status: AgentSessionStatuses.COMPLETED, error: null },
      failedEvents: [],
    })
  })
})
