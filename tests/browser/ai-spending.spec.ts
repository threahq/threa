import { test, expect, type Page } from "@playwright/test"
import { createRequire } from "node:module"
import type { Querier } from "../../apps/backend/src/db"
import { AI_SPENDING_COVERAGE } from "../../packages/types/src/ai-spending"
import { INTERNAL_API_KEY_HEADER } from "../../packages/types/src/constants"
import { spendingTestDatabaseUrl } from "../../playwright.spending.config"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

const { Pool } = createRequire(new URL("../../apps/backend/package.json", import.meta.url))("pg")
const pool: Querier & { end(): Promise<void> } = new Pool({ connectionString: spendingTestDatabaseUrl, max: 2 })
test.afterAll(() => pool.end())

async function setLimit(page: Page, workspaceId: string, amount: string) {
  const url = `http://localhost:${process.env.PLAYWRIGHT_BACKEND_PORT}/internal/ai-spending/workspaces/${workspaceId}`
  const headers = { [INTERNAL_API_KEY_HEADER]: process.env.PLAYWRIGHT_INTERNAL_API_KEY! }
  const current = await page.request.get(url, { headers })
  await expectApiOk(current, "Read spending policy")
  const { policy } = await current.json()
  const updated = await page.request.put(url, {
    headers,
    data: {
      expectedVersion: policy?.version ?? 0,
      operatorWorkosUserId: "spending-browser-operator",
      status: "enforced",
      coverageProfile: AI_SPENDING_COVERAGE.profile,
      limits: {
        agentCutoffUsd: amount,
        enrichmentCutoffUsd: amount,
        coreCutoffUsd: amount,
        embeddingCutoffUsd: amount,
        operatorCeilingUsd: amount,
      },
    },
  })
  await expectApiOk(updated, "Apply spending limits")
}

async function send(page: Page, text: string) {
  const editor = page.locator("[contenteditable='true']").first()
  await editor.fill(text)
  await editor.press("Meta+Enter")
  await expect(page.getByText(text, { exact: true }).first()).toBeVisible()
}

async function attempts(workspaceId: string) {
  return (
    await pool.query(
      "SELECT id, state, actual_cost_usd, sponsor_user_id, session_id FROM ai_spending_attempts WHERE workspace_id = $1 ORDER BY created_at",
      [workspaceId]
    )
  ).rows
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`protected assistant replies, stops without egress, and accepts a new request at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000)
    await page.setViewportSize(viewport)
    await loginAndCreateWorkspace(page, "spending")
    const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]!
    await page.goto(`/w/${workspaceId}/admin/ai-usage`)
    const legacyBudget = page.getByRole("spinbutton", { name: "Monthly budget" })
    await expect(legacyBudget).toBeVisible()
    await setLimit(page, workspaceId, "5")
    await legacyBudget.fill("1")
    await legacyBudget.press("Tab")
    const budget = await page.request.get(`/api/workspaces/${workspaceId}/ai-budget`)
    expect((await budget.json()).spendingControlsActive).toBe(true)
    const legacyWrite = await page.request.put(`/api/workspaces/${workspaceId}/ai-budget`, {
      data: { monthlyBudgetUsd: 1 },
    })
    expect(legacyWrite.status()).toBe(403)
    await expect(
      page.getByText("This workspace uses AI spending controls. The previous budget settings are inactive.")
    ).toBeVisible()
    await expect(page.getByRole("spinbutton", { name: "Monthly budget" })).not.toBeVisible()
    await page.goto(`/w/${workspaceId}`)
    const voice = await page.request.post(`/api/workspaces/${workspaceId}/voice/sessions`, { data: {} })
    expect(voice.status()).toBe(403)
    expect(await voice.json()).toMatchObject({
      code: "AI_SPENDING_DENIED",
      details: { reason: "UNSUPPORTED_OPERATION" },
    })
    if (viewport.width < 768)
      await page.locator("header").getByRole("button", { name: "Pin sidebar", exact: true }).click()
    await page.getByRole("button", { name: "+ New Scratchpad" }).click({ timeout: 10_000 })
    await send(page, "Please reply to this protected request.")
    await expect(page.getByText("Your protected assistant reply.", { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    })
    await expect.poll(async () => (await attempts(workspaceId)).map((row) => row.state)).toEqual(["settled"])
    const [paid] = await attempts(workspaceId)
    expect(paid).toMatchObject({ actual_cost_usd: "0.00010000" })
    const session = await pool.query("SELECT initiating_user_id FROM agent_sessions WHERE id = $1", [paid.session_id])
    expect(paid.sponsor_user_id).toBe(session.rows[0].initiating_user_id)
    const usage = await pool.query(
      "SELECT function_id, user_id, cost_usd::text, metadata->>'spendingAttemptId' AS attempt_id FROM ai_usage_records WHERE workspace_id=$1",
      [workspaceId]
    )
    expect(usage.rows).toEqual([
      { function_id: "agent-loop", user_id: paid.sponsor_user_id, cost_usd: "0.00010000", attempt_id: paid.id },
    ])

    await setLimit(page, workspaceId, "0")
    const before = await pool.query("SELECT COUNT(*)::int AS n FROM spending_test_egress")
    await send(page, "This request must stop before the provider.")
    await expect(page.getByText("AI stopped", { exact: true })).toBeVisible({ timeout: 45_000 })
    await expect(page.getByText(/An AI spending limit was reached/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("spending-stopped.png"), fullPage: true })
    await page.getByText("AI stopped", { exact: true }).click()
    const trace = page.getByRole("dialog")
    await expect(trace.getByText("AI stopped", { exact: true }).first()).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(trace).not.toBeVisible()
    expect(await attempts(workspaceId)).toEqual([paid])
    const after = await pool.query("SELECT COUNT(*)::int AS n FROM spending_test_egress")
    expect(after.rows).toEqual(before.rows)
    const stopped = await pool.query(
      "SELECT s.id, s.stop_reason FROM agent_sessions s JOIN streams st ON st.id = s.stream_id WHERE st.workspace_id = $1 AND s.stop_reason IS NOT NULL",
      [workspaceId]
    )
    expect(stopped.rows).toEqual([{ id: expect.any(String), stop_reason: "spending_denied" }])

    await setLimit(page, workspaceId, "5")
    await send(page, "Start a new authorized request.")
    await expect.poll(async () => (await attempts(workspaceId)).map((row) => row.state)).toEqual(["settled", "settled"])
    await expect(page.getByText("Your protected assistant reply.", { exact: true })).toHaveCount(2)
    const prior = await pool.query("SELECT status, stop_reason FROM agent_sessions WHERE id = $1", [stopped.rows[0].id])
    expect(prior.rows).toEqual([{ status: "failed", stop_reason: "spending_denied" }])
  })
}
