/**
 * What a turn inside a subagent thread runs on, and what it may reach for.
 *
 * Three seams, all keyed off ONE database read (`findActiveByThreadStream`, the
 * call `server.ts` binds as `loadActiveSubagentRun`): the turn's model is the
 * run's pinned binding for as long as the run lives, the run's own closing tool
 * is bound only there, and `delegate_to_model` is NOT — a subagent that could
 * delegate onward is the nesting this design refuses. The gate
 * (`canOfferSubagentDelegation`) and the builder (`buildToolSet`) are the
 * production ones; only the dep wiring around them is restated here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { AgentToolNames } from "@threa/types"
import { buildToolSet } from "../../src/features/agents/companion"
import { canOfferSubagentDelegation } from "../../src/features/agents/tools"
import { resolveTurnModel } from "../../src/features/agents/turn-model"
import { resolveTurnPurpose } from "../../src/features/agents/turn-purpose"
import { StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import { SubagentService } from "../../src/features/subagents"
import { JobQueues, QueueRepository } from "../../src/lib/queue"
import { messageId } from "../../src/lib/id"
import { setupIsolatedTestDatabase } from "./setup"
import {
  DELEGATED_MODEL,
  PERSONA_MODEL,
  createParams,
  createSubagentTestContext,
  type SubagentTestContext,
} from "./subagent-support"

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-binding")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "binding")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
})

afterAll(async () => {
  await cleanup()
})

/** The `loadActiveSubagentRun` dep, exactly as `server.ts` binds it. */
function loadActiveSubagentRun(threadStreamId: string) {
  return subagentService.findActiveByThreadStream({ workspaceId: ctx.workspaceId, threadStreamId })
}

/**
 * The tool names a turn in `streamId` would be offered, wired the way
 * `PersonaAgent.run` wires them: the active run decides both bindings, and the
 * delegation gate additionally sees the stream's sealing and the invoking user.
 */
async function turnToolNames(streamId: string, options: { invokingUserId?: string } = {}): Promise<string[]> {
  const stream = await StreamRepository.findById(pool, streamId)
  const run = await loadActiveSubagentRun(streamId)
  const invokingUserId = "invokingUserId" in options ? options.invokingUserId : ctx.owner

  const offerDelegation = canOfferSubagentDelegation({
    wired: true,
    invokingUserId,
    e2eEnabled: stream?.e2eEnabled === true,
    insideSubagentThread: run !== null,
  })

  return buildToolSet({
    enabledTools: null,
    subagentDelegation: offerDelegation
      ? { allowedModels: [DELEGATED_MODEL], delegateToModel: async () => ({ ok: false, reason: "failed" }) }
      : undefined,
    reportBack: run ? { reportBack: async () => ({ ok: true, subagentId: run.id }) } : undefined,
  }).map((tool) => tool.name)
}

describe("pinned model", () => {
  test("the kickoff turn and every later reply run the run's model, not the persona's", async () => {
    const channel = await ctx.createChannel({ slug: "pinned" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    const now = new Date()
    const [job] = await QueueRepository.batchClaimMessages(pool, {
      queueName: JobQueues.PERSONA_AGENT,
      workspaceId: ctx.workspaceId,
      now,
      claimedAt: now,
      claimedBy: "test",
      claimedUntil: new Date(now.getTime() + 60_000),
      limit: 5,
    })
    const kickoffPurpose = resolveTurnPurpose(job.payload as Record<string, string>)
    expect(kickoffPurpose).toEqual({ kind: "subagent_kickoff", subagentRunId: run.id })

    const kickoffRun = await loadActiveSubagentRun(threadStreamId)
    expect(
      resolveTurnModel(ctx.persona, {
        purpose: kickoffPurpose,
        supersededSession: null,
        activeSubagentModel: kickoffRun?.model ?? null,
      })
    ).toEqual({ model: DELEGATED_MODEL, escalated: true, cause: "subagent" })

    // The user answers in the thread: an ordinary catch-up turn, same binding.
    const replyRun = await loadActiveSubagentRun(threadStreamId)
    expect(
      resolveTurnModel(ctx.persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: replyRun?.model ?? null,
      })
    ).toEqual({ model: DELEGATED_MODEL, escalated: true, cause: "subagent" })
  })

  test("once the run reports back the thread falls back to the persona's own model", async () => {
    const channel = await ctx.createChannel({ slug: "pinned-released" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))
    await subagentService.reportBack({
      workspaceId: ctx.workspaceId,
      id: run.id,
      resultMessageId: messageId(),
    })

    const settledRun = await loadActiveSubagentRun(threadStreamId)
    expect(settledRun).toBeNull()
    expect(
      resolveTurnModel(ctx.persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: settledRun?.model ?? null,
      })
    ).toEqual({ model: PERSONA_MODEL, escalated: false })
  })

  test("a run pinned to the persona's own model is not an escalation", async () => {
    const channel = await ctx.createChannel({ slug: "pinned-same" })
    const { threadStreamId } = await subagentService.create(createParams(ctx, channel.id, { model: PERSONA_MODEL }))

    const run = await loadActiveSubagentRun(threadStreamId)
    expect(
      resolveTurnModel(ctx.persona, {
        purpose: { kind: "catch_up" },
        supersededSession: null,
        activeSubagentModel: run?.model ?? null,
      })
    ).toEqual({ model: PERSONA_MODEL, escalated: false })
  })
})

describe("tool binding", () => {
  test("a subagent thread gets report_back and cannot delegate onward", async () => {
    const channel = await ctx.createChannel({ slug: "tools-thread" })
    const { threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    const names = await turnToolNames(threadStreamId)

    expect(names).toContain(AgentToolNames.REPORT_BACK)
    expect(names).not.toContain(AgentToolNames.DELEGATE_TO_MODEL)
  })

  test("the parent stream gets delegate_to_model and no report_back", async () => {
    const channel = await ctx.createChannel({ slug: "tools-parent" })
    await subagentService.create(createParams(ctx, channel.id))

    const names = await turnToolNames(channel.id)

    expect(names).toContain(AgentToolNames.DELEGATE_TO_MODEL)
    expect(names).not.toContain(AgentToolNames.REPORT_BACK)
  })

  test("once the run settles the thread can delegate again and loses report_back", async () => {
    const channel = await ctx.createChannel({ slug: "tools-settled" })
    const { run, threadStreamId } = await subagentService.create(createParams(ctx, channel.id))
    await subagentService.reportBack({
      workspaceId: ctx.workspaceId,
      id: run.id,
      resultMessageId: messageId(),
    })

    const names = await turnToolNames(threadStreamId)

    expect(names).toContain(AgentToolNames.DELEGATE_TO_MODEL)
    expect(names).not.toContain(AgentToolNames.REPORT_BACK)
  })

  test("a sealed stream never offers delegation — the brief is server-built plaintext", async () => {
    const sealed = await ctx.streamService.createScratchpad({
      workspaceId: ctx.workspaceId,
      createdBy: ctx.owner,
      e2e: { ownerKeyId: "e2ek_subagent_test" },
    })
    expect(await E2eStreamsRepository.isE2eStream(pool, ctx.workspaceId, sealed.id)).toBe(true)

    const names = await turnToolNames(sealed.id)

    expect(names).not.toContain(AgentToolNames.DELEGATE_TO_MODEL)
    expect(names).not.toContain(AgentToolNames.REPORT_BACK)
  })

  test("a turn no human triggered never offers delegation — the run needs a user's authority", async () => {
    const channel = await ctx.createChannel({ slug: "tools-no-user" })

    const names = await turnToolNames(channel.id, { invokingUserId: undefined })

    expect(names).not.toContain(AgentToolNames.DELEGATE_TO_MODEL)
  })
})
