/**
 * Which models a persona may actually delegate to, decided where the model
 * crosses the boundary rather than where the tool was described.
 *
 * Two gates in one order (INV-33, `resolveSubagentModels`): the registry says
 * what exists, the workspace's `subagentModels` says what it pays for. Both are
 * re-resolved at execution, so an allowlist that moved mid-turn cannot be used
 * to delegate off-policy — and a refusal carries the current set, so the model's
 * next attempt is a choice rather than another guess.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { createModelRegistry, type ModelRegistry } from "@threa/agent-runtime"
import { DEFAULT_SUBAGENT_MODELS } from "@threa/types"
import { createDelegateToModelTool } from "../../src/features/agents/tools"
import { StreamEventRepository } from "../../src/features/streams"
import { SubagentService, delegateToSubagent, resolveSubagentModels } from "../../src/features/subagents"
import { WorkspaceSettingsService } from "../../src/features/workspace-settings"
import { HttpError } from "../../src/lib/errors"
import { setupIsolatedTestDatabase } from "./setup"
import { createParams, createSubagentTestContext, type SubagentTestContext } from "./subagent-support"

const OFF_POLICY_MODEL = "openrouter:anthropic/claude-opus-5"
const UNKNOWN_MODEL = "openrouter:nobody/never-shipped"
const EXEC_OPTS = { toolCallId: "call_1" }

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService
let workspaceSettingsService: WorkspaceSettingsService
let modelRegistry: ModelRegistry

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-allowlist")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "allowlist")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
  modelRegistry = createModelRegistry()
  workspaceSettingsService = new WorkspaceSettingsService(pool, modelRegistry)
})

afterAll(async () => {
  await cleanup()
})

/** The `delegate_to_model` tool as `server.ts` binds it, for one stream. */
async function toolForStream(parentStreamId: string) {
  const allowedModels = resolveSubagentModels({
    workspaceSettings: await workspaceSettingsService.getSettings(ctx.workspaceId),
    modelRegistry,
  })
  return createDelegateToModelTool({
    allowedModels,
    delegateToModel: ({ model, title, brief }) =>
      delegateToSubagent(
        {
          subagentService,
          modelRegistry,
          loadWorkspaceSettings: (workspaceId) => workspaceSettingsService.getSettings(workspaceId),
        },
        { ...createParams(ctx, parentStreamId, { model, title }), brief }
      ),
  })
}

function parse(output: string) {
  return JSON.parse(output) as Record<string, unknown>
}

const input = { title: "Second opinion", brief: "Here is everything you need to answer." }

/** Rows the `active` unique index would see for this conversation surface. */
async function activeRunCount(scopeStreamId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM subagent_runs WHERE scope_stream_id = $1 AND status = 'active'`,
    [scopeStreamId]
  )
  return Number(rows[0].count)
}

describe("governed model set", () => {
  test("a workspace with no override delegates on the shipped default set", async () => {
    const channel = await ctx.createChannel({ slug: "allowlist-default" })
    const tool = await toolForStream(channel.id)

    const result = await tool.config.execute({ ...input, model: DEFAULT_SUBAGENT_MODELS[0] }, EXEC_OPTS)

    const parsed = parse(result.output)
    expect(parsed).toMatchObject({ ok: true, model: DEFAULT_SUBAGENT_MODELS[0] })
    expect(
      await subagentService.getById({ workspaceId: ctx.workspaceId, id: parsed.subagentId as string })
    ).toMatchObject({ model: DEFAULT_SUBAGENT_MODELS[0], parentStreamId: channel.id })
  })

  test("an off-policy model is refused with the set to choose from, and opens nothing", async () => {
    const channel = await ctx.createChannel({ slug: "allowlist-refused" })
    const tool = await toolForStream(channel.id)

    const result = await tool.config.execute({ ...input, model: OFF_POLICY_MODEL }, EXEC_OPTS)

    expect(parse(result.output)).toMatchObject({ ok: false, allowedModels: DEFAULT_SUBAGENT_MODELS })
    expect(await activeRunCount(channel.id)).toBe(0)
    expect(await StreamEventRepository.list(pool, channel.id, { types: ["subagent:created"] })).toHaveLength(0)
  })

  test("a model the registry has never heard of is refused the same way", async () => {
    const channel = await ctx.createChannel({ slug: "allowlist-unknown" })
    const tool = await toolForStream(channel.id)

    const result = await tool.config.execute({ ...input, model: UNKNOWN_MODEL }, EXEC_OPTS)

    expect(parse(result.output)).toMatchObject({ ok: false })
    expect(await activeRunCount(channel.id)).toBe(0)
  })

  test("the stream's one live slot is reported as a refusal the model can act on", async () => {
    const channel = await ctx.createChannel({ slug: "allowlist-active" })
    const tool = await toolForStream(channel.id)
    await subagentService.create(createParams(ctx, channel.id))

    const result = await tool.config.execute({ ...input, model: DEFAULT_SUBAGENT_MODELS[0] }, EXEC_OPTS)

    expect(parse(result.output).ok).toBe(false)
    expect(String(parse(result.output).error)).toContain("already running")
  })
})

describe("workspace override", () => {
  test("an admin's set replaces the default in both directions", async () => {
    const settings = await workspaceSettingsService.updateSettings(ctx.workspaceId, {
      subagentModels: [OFF_POLICY_MODEL],
    })
    expect(settings.subagentModels).toEqual([OFF_POLICY_MODEL])

    try {
      const allowedChannel = await ctx.createChannel({ slug: "override-allowed" })
      const allowed = await (
        await toolForStream(allowedChannel.id)
      ).config.execute({ ...input, model: OFF_POLICY_MODEL }, EXEC_OPTS)
      expect(parse(allowed.output)).toMatchObject({ ok: true, model: OFF_POLICY_MODEL })

      const refusedChannel = await ctx.createChannel({ slug: "override-refused" })
      const refused = await (
        await toolForStream(refusedChannel.id)
      ).config.execute({ ...input, model: DEFAULT_SUBAGENT_MODELS[0] }, EXEC_OPTS)
      expect(parse(refused.output)).toMatchObject({ ok: false, allowedModels: [OFF_POLICY_MODEL] })
    } finally {
      await workspaceSettingsService.updateSettings(ctx.workspaceId, { subagentModels: DEFAULT_SUBAGENT_MODELS })
    }

    expect((await workspaceSettingsService.getSettings(ctx.workspaceId)).subagentModels).toEqual(
      DEFAULT_SUBAGENT_MODELS
    )
  })

  test("a set containing a model the registry does not serve is rejected on write", async () => {
    const error = await workspaceSettingsService
      .updateSettings(ctx.workspaceId, { subagentModels: [UNKNOWN_MODEL] })
      .catch((err: unknown) => err)

    // An HttpError so the workspace admin sees a 400, not a 500 (INV-32).
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 400, code: "UNKNOWN_SUBAGENT_MODEL" })
    expect((await workspaceSettingsService.getSettings(ctx.workspaceId)).subagentModels).toEqual(
      DEFAULT_SUBAGENT_MODELS
    )
  })

  test("a stored model that leaves the registry stops being delegable without a settings edit", async () => {
    await workspaceSettingsService.updateSettings(ctx.workspaceId, {
      subagentModels: [OFF_POLICY_MODEL, DEFAULT_SUBAGENT_MODELS[0]],
    })

    try {
      const retiredRegistry: ModelRegistry = {
        ...modelRegistry,
        isChatModel: (model: string) => model !== OFF_POLICY_MODEL && modelRegistry.isChatModel(model),
      }
      const allowed = resolveSubagentModels({
        workspaceSettings: await workspaceSettingsService.getSettings(ctx.workspaceId),
        modelRegistry: retiredRegistry,
      })

      expect(allowed).toEqual([DEFAULT_SUBAGENT_MODELS[0]])
    } finally {
      await workspaceSettingsService.updateSettings(ctx.workspaceId, { subagentModels: DEFAULT_SUBAGENT_MODELS })
    }
  })
})
