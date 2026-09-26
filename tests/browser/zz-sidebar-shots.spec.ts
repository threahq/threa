import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 240_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/sidebar-shots"

async function api<T = any>(page: Page, method: "post" | "get", url: string, data?: unknown): Promise<T> {
  const response = await page.request[method](url, data ? { data } : undefined)
  await expectApiOk(response, `${method} ${url}`)
  return (await response.json()) as T
}

function idOf(json: any, key: string): string {
  const id = json?.[key]?.id ?? json?.data?.id ?? json?.id
  if (!id) throw new Error(`no id in ${JSON.stringify(json).slice(0, 300)}`)
  return id
}

test("board sidebar and hover card screenshots", async ({ page, browser }) => {
  const owner = await loginAndCreateWorkspace(page, "board-shots")
  const ws = page.url().match(/\/w\/([^/?]+)/)![1]
  const t = owner.testId
  const channel = async (slug: string) =>
    idOf(await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug, visibility: "public" }), "stream")
  const say = async (p: Page, streamId: string, content: string) =>
    idOf(await api(p, "post", `/api/workspaces/${ws}/messages`, { streamId, content }), "message")
  const thread = async (parentStreamId: string, parentAnchorId: string) =>
    idOf(await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "thread", parentStreamId, parentAnchorId }), "stream")

  const design = await channel(`design-${t}`)
  const eng = await channel(`eng-${t}`)
  const m1 = await say(page, design, "Sidebar redesign kickoff")
  await say(page, design, "Dense rows land today")
  await say(page, design, "Hover card next, it should read like the timeline")
  const t1 = await thread(design, m1)
  await say(page, t1, "Tree lines follow the prototype")
  const m3 = await say(page, eng, "Deploy checklist")
  await thread(eng, m3)

  const other = await loginInNewContext(browser, `board-shots-b-${t}@example.com`, `Board Shots B ${t}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${ws}/join`, { data: { role: "member", name: `Maja ${t}` } }),
    "join workspace"
  )
  for (const s of [design, eng]) {
    await expectApiOk(await other.page.request.post(`/api/workspaces/${ws}/streams/${s}/join`, { data: {} }), "join")
  }
  await say(other.page, design, "Looks good")
  await say(
    other.page,
    design,
    "One nit on the divider: it should sit on the baseline of the first unread message and not float above it, otherwise the New label reads as if it belongs to the previous run of messages. Happy to pair on it."
  )
  const fixed = await say(page, design, "Fixed, take another look")
  await say(other.page, eng, "Staging is green")
  await api(other.page, "post", `/api/workspaces/${ws}/messages/${fixed}/reactions`, { emoji: "👍" })
  const random = idOf(
    await api(other.page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `random-${t}`, visibility: "public" }),
    "stream"
  )
  await say(other.page, random, "Lunch?")

  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 860 } })
  const dp = await desk.newPage()
  await dp.goto(`/w/${ws}/s/${eng}`)
  await expect(dp.locator(`a[href*='/s/${t1}']`).first()).toBeAttached({ timeout: 30_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 5000 }).catch(() => {})
  await dp.waitForTimeout(1500)
  await dp.locator(`a[href$='/s/${design}']`).first().hover()
  const card = dp.locator("[data-radix-popper-content-wrapper]").first()
  await expect(card.getByText("Fixed, take another look")).toBeVisible({ timeout: 10_000 })
  await dp.waitForTimeout(800)
  await dp.screenshot({ path: `${OUT}/hover-card.png` })
  await dp.locator("[data-radix-popper-content-wrapper]").first().screenshot({ path: `${OUT}/hover-card-close.png` })
  await card.getByText("Dense rows land today").hover()
  await dp.waitForTimeout(400)
  await dp.locator("[data-radix-popper-content-wrapper]").first().screenshot({ path: `${OUT}/hover-card-row-hover.png` })

  // Reactions: the seeded pill, then the viewer's own +1, then the picker nested in the card
  await expect(card.getByRole("button", { name: /👍\s*1/ })).toBeVisible()
  await card.getByRole("button", { name: /👍\s*1/ }).click()
  await expect(card.getByRole("button", { name: /👍\s*2/ })).toBeVisible()
  await dp.waitForTimeout(600)
  await card.getByText("Fixed, take another look").hover()
  await dp.waitForTimeout(300)
  await card.screenshot({ path: `${OUT}/hover-card-reacted.png` })
  const fixedRow = card.locator("div.group\\/row", { hasText: "Fixed, take another look" })
  await fixedRow.getByRole("button", { name: "Add reaction" }).click()
  await dp.getByPlaceholder("Search emoji...").fill("fire")
  const picker = dp.getByRole("option", { name: ":fire:" }).first()
  await expect(picker).toBeVisible({ timeout: 5000 })
  await expect(card.getByText("Dense rows land today")).toBeVisible()
  await dp.waitForTimeout(400)
  await dp.screenshot({ path: `${OUT}/hover-card-picker.png` })
  await picker.click()
  await expect(card.getByRole("button", { name: /🔥\s*1/ })).toBeVisible()
  await expect(card.getByText("Dense rows land today")).toBeVisible()
  await dp.waitForTimeout(500)
  await card.screenshot({ path: `${OUT}/hover-card-fire.png` })
  const stored = await api(dp, "get", `/api/workspaces/${ws}/streams/${design}/events?type=reaction_added&limit=20`)
  const added = (stored.events ?? stored.data?.events).filter((e: any) => e.payload.messageId === fixed)
  expect(added.map((e: any) => e.payload.emoji).sort()).toEqual([":+1:", ":+1:", ":fire:"])
  await dp.mouse.move(900, 500)
  await dp.waitForTimeout(600)

  // Row menu: Browse streams
  await dp.locator(`a[href$='/s/${eng}']`).first().click({ button: "right" })
  await expect(dp.getByRole("menuitem", { name: "Browse streams" })).toBeVisible({ timeout: 5000 })
  await dp.waitForTimeout(300)
  await dp.screenshot({ path: `${OUT}/row-menu-browse.png` })
  await dp.getByRole("menuitem", { name: "Browse streams" }).click()
  await expect(dp).toHaveURL(/\/streams/)
  await expect(dp.getByRole("region", { name: "Most active" })).toBeVisible({ timeout: 15_000 })
  await dp.waitForTimeout(1500)
  await dp.screenshot({ path: `${OUT}/explorer.png`, fullPage: true })
  await dp.locator("li", { hasText: `#random-${t}` }).last().hover()
  await expect(dp.locator("[data-radix-popper-content-wrapper]").getByText("Lunch?")).toBeVisible({ timeout: 10_000 })
  await dp.waitForTimeout(600)
  await dp.screenshot({ path: `${OUT}/explorer-hover.png` })
  await dp.mouse.move(1200, 20)
  await dp.goto(`/w/${ws}/streams?sort=members&show=not-joined`)
  await dp.waitForTimeout(2500)
  await dp.screenshot({ path: `${OUT}/explorer-filtered.png` })

  await dp.setViewportSize({ width: 1280, height: 1250 })
  await dp.goto(`/w/${ws}/board`)
  await dp.waitForTimeout(4000)
  await dp.screenshot({ path: `${OUT}/board.png` })
  await desk.close()
})
