import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 180_000 })
const OUT = process.env.SHOTS_DIR ?? "/tmp/sidebar-shots"

async function api<T = any>(page: Page, method: "post" | "get", url: string, data?: unknown): Promise<T> {
  const response = await page.request[method](url, data ? { data } : undefined)
  await expectApiOk(response, `${method} ${url}`)
  return (await response.json()) as T
}
const idOf = (json: any, key: string): string => json?.[key]?.id ?? json?.data?.id ?? json?.id

test("card overflow after reacting", async ({ page, browser }) => {
  await loginAndCreateWorkspace(page, "card-ovf")
  const ws = page.url().match(/\/w\/([^/?]+)/)![1]
  const ch = idOf(await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `ovf-${Date.now()}`, visibility: "public" }), "stream")
  const other = idOf(await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `zz-${Date.now()}`, visibility: "public" }), "stream")
  for (let i = 1; i <= 24; i++) await api(page, "post", `/api/workspaces/${ws}/messages`, { streamId: ch, content: i === 24 ? "row 10" : `row ${i} with a longer body so the card has to wrap onto a few lines and fill up its height` })
  await api(page, "post", `/api/workspaces/${ws}/messages`, { streamId: other, content: "x" })

  const storageState = await page.context().storageState()
  const ctx = await browser.newContext({ storageState, viewport: { width: 1280, height: Number(process.env.VH ?? 560) } })
  const dp = await ctx.newPage()
  await dp.goto(`/w/${ws}/s/${other}`)
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 5000 }).catch(() => {})
  await dp.waitForTimeout(1500)
  await dp.locator(`a[href$='/s/${ch}']`).first().hover()
  const card = dp.locator("[data-radix-popper-content-wrapper]").first()
  await expect(card.getByText("row 10", { exact: true })).toBeAttached({ timeout: 10_000 })
  await dp.waitForTimeout(600)
  const geom = async (label: string) => {
    const g = await card.evaluate((el) => {
      const sc = el.querySelector(".overflow-y-auto") as HTMLElement
      const r = sc.getBoundingClientRect()
      const pill = [...el.querySelectorAll("button")].find((b) => /\d/.test(b.textContent ?? "") && b.getAttribute("aria-label") !== "Add reaction")
      const last = [...el.querySelectorAll("p")].find((p) => p.textContent === "row 10")
      return {
        scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, scBottom: Math.round(r.bottom),
        lastBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
        pillBottom: pill ? Math.round(pill.getBoundingClientRect().bottom) : null,
      }
    })
    console.log(label, JSON.stringify(g))
    return g
  }
  const g0 = await geom("open")
  await dp.screenshot({ path: `${OUT}/ovf-open.png` })
  expect(g0.lastBottom!).toBeLessThanOrEqual(g0.scBottom)
  const firstRow = card.locator("div.group\\/row").first()
  await firstRow.hover()
  await dp.waitForTimeout(300)
  await dp.screenshot({ path: `${OUT}/ovf-hover-first.png` })
  const mid = card.locator("div.group\\/row").nth(4)
  await mid.hover()
  await dp.waitForTimeout(300)
  await card.screenshot({ path: `${OUT}/ovf-hover-mid.png` })
  const lastRow = card.locator("div.group\\/row", { hasText: "row 10" })
  await lastRow.hover()
  await dp.waitForTimeout(300)
  await dp.screenshot({ path: `${OUT}/ovf-hover.png` })
  await lastRow.getByRole("button", { name: "Add reaction" }).click()
  await dp.getByPlaceholder("Search emoji...").fill("fire")
  await dp.getByRole("option", { name: ":fire:" }).first().click()
  await dp.waitForTimeout(300)
  await geom("after-pick")
  await dp.waitForTimeout(2500)
  const g = await geom("settled")
  await dp.screenshot({ path: `${OUT}/ovf-settled.png` })
  expect(g.pillBottom).not.toBeNull()
  expect(g.pillBottom!).toBeLessThanOrEqual(g.scBottom)
})
