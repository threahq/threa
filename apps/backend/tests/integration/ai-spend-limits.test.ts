import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { addTestMember, setupTestDatabase } from "./setup"
import { AISpendGate, createAIUsageHandlers } from "../../src/features/ai-usage"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"

function mockReq(workspace: string, overrides: Record<string, unknown> = {}) {
  return { workspaceId: workspace, query: {}, body: {}, params: {}, ...overrides } as never
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.body = data
      return res
    },
    send() {
      return res
    },
  }
  return res
}

describe("AI spend limit endpoints", () => {
  let pool: Pool
  let handlers: ReturnType<typeof createAIUsageHandlers>
  let gate: AISpendGate
  const workspaces: string[] = []

  beforeAll(async () => {
    pool = await setupTestDatabase()
    handlers = createAIUsageHandlers({ pool })
    gate = new AISpendGate({ pool })
  })

  afterAll(async () => {
    await pool.query("DELETE FROM ai_budgets WHERE workspace_id = ANY($1)", [workspaces])
    await pool.query("DELETE FROM ai_user_quotas WHERE workspace_id = ANY($1)", [workspaces])
    await pool.end()
  })

  async function seedWorkspace() {
    const id = workspaceId()
    workspaces.push(id)
    const creator = userId()
    await WorkspaceRepository.insert(pool, { id, name: "Spend limits", slug: `spend-limits-${id}`, createdBy: creator })
    const member = await addTestMember(pool, id, userId())
    return { workspaceId: id, memberId: member.id }
  }

  async function call(handler: (req: never, res: never) => Promise<unknown>, req: never) {
    const res = mockRes()
    await handler(req, res as never)
    return res
  }

  test("should report the enforced defaults for a workspace with no budget row", async () => {
    const { workspaceId: ws } = await seedWorkspace()

    const res = await call(handlers.getBudget, mockReq(ws))

    expect((res.body as { budget: unknown }).budget).toEqual({
      monthlyBudgetUsd: 50,
      alertThreshold50: true,
      alertThreshold80: true,
      alertThreshold100: true,
      aiDisabled: false,
      defaultUserAgentAllowanceUsd: null,
      operatorCeilingUsd: 50,
      operatorAiDisabled: false,
    })
  })

  test("should keep the default agent allowance when omitted, clear it on null, and round-trip aiDisabled", async () => {
    const { workspaceId: ws } = await seedWorkspace()
    const budget = async (body: Record<string, unknown>) =>
      ((await call(handlers.updateBudget, mockReq(ws, { body }))).body as { budget: unknown }).budget

    const created = await budget({ defaultUserAgentAllowanceUsd: 3, aiDisabled: true })
    const omitted = await budget({ monthlyBudgetUsd: 20 })
    const cleared = await budget({ defaultUserAgentAllowanceUsd: null, aiDisabled: false })
    const read = ((await call(handlers.getBudget, mockReq(ws))).body as { budget: unknown }).budget

    const base = {
      alertThreshold50: true,
      alertThreshold80: true,
      alertThreshold100: true,
      operatorCeilingUsd: 50,
      operatorAiDisabled: false,
    }
    expect({ created, omitted, cleared, read }).toEqual({
      created: { ...base, monthlyBudgetUsd: 50, aiDisabled: true, defaultUserAgentAllowanceUsd: 3 },
      omitted: { ...base, monthlyBudgetUsd: 20, aiDisabled: true, defaultUserAgentAllowanceUsd: 3 },
      cleared: { ...base, monthlyBudgetUsd: 20, aiDisabled: false, defaultUserAgentAllowanceUsd: null },
      read: { ...base, monthlyBudgetUsd: 20, aiDisabled: false, defaultUserAgentAllowanceUsd: null },
    })
  })

  test("should reject a budget update that tries to change operator fields", async () => {
    const { workspaceId: ws } = await seedWorkspace()

    await expect(
      call(handlers.updateBudget, mockReq(ws, { body: { operatorCeilingUsd: 1000, operatorAiDisabled: true } }))
    ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    await expect(call(handlers.getBudget, mockReq(ws))).resolves.toMatchObject({
      body: { budget: { operatorCeilingUsd: 50, operatorAiDisabled: false } },
    })
  })

  test("should upsert, list and delete per-user limits", async () => {
    const { workspaceId: ws, memberId } = await seedWorkspace()
    const put = (body: Record<string, unknown>) =>
      call(handlers.setUserLimits, mockReq(ws, { params: { userId: memberId }, body }))
    const list = async () => (await call(handlers.listUserLimits, mockReq(ws))).body

    const first = (await put({ monthlyQuotaUsd: 10, agentAllowanceUsd: 4, aiDisabled: false })).body
    const replaced = (await put({ monthlyQuotaUsd: null, agentAllowanceUsd: null, aiDisabled: true })).body
    const listed = await list()
    const deleted = await call(handlers.deleteUserLimits, mockReq(ws, { params: { userId: memberId } }))
    const afterDelete = await list()

    expect({ first, replaced, listed, deletedStatus: deleted.statusCode, afterDelete }).toEqual({
      first: { limits: { userId: memberId, monthlyQuotaUsd: 10, agentAllowanceUsd: 4, aiDisabled: false } },
      replaced: { limits: { userId: memberId, monthlyQuotaUsd: null, agentAllowanceUsd: null, aiDisabled: true } },
      listed: { limits: [{ userId: memberId, monthlyQuotaUsd: null, agentAllowanceUsd: null, aiDisabled: true }] },
      deletedStatus: 204,
      afterDelete: { limits: [] },
    })
  })

  test("should 404 when setting limits for a user outside the workspace", async () => {
    const { workspaceId: ws } = await seedWorkspace()
    const { memberId: outsider } = await seedWorkspace()

    await expect(
      call(
        handlers.setUserLimits,
        mockReq(ws, {
          params: { userId: outsider },
          body: { monthlyQuotaUsd: null, agentAllowanceUsd: null, aiDisabled: true },
        })
      )
    ).rejects.toMatchObject({ status: 404, code: "USER_NOT_FOUND" })
  })

  test("should deny a user's calls once an admin switches their AI off", async () => {
    const { workspaceId: ws, memberId } = await seedWorkspace()
    const admit = () => gate.admit({ workspaceId: ws, userId: memberId, functionId: "message-embedding" })

    const before = await admit()
    await call(
      handlers.setUserLimits,
      mockReq(ws, {
        params: { userId: memberId },
        body: { monthlyQuotaUsd: null, agentAllowanceUsd: null, aiDisabled: true },
      })
    )
    const disabled = await admit()
    await call(handlers.deleteUserLimits, mockReq(ws, { params: { userId: memberId } }))
    const restored = await admit()

    expect({ before, disabled, restored }).toEqual({
      before: { allowed: true },
      disabled: { allowed: false, reason: "user_disabled" },
      restored: { allowed: true },
    })
  })
})
