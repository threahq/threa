import { test, expect, type Page } from "@playwright/test"
import { devLogin, generateTestId, waitForWorkspaceProvisioned, loginInNewContext, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 1_800_000 })
test.use({ actionTimeout: 60_000, navigationTimeout: 120_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/order-shots"
const PHONE = { width: 390, height: 780 }

async function api<T = any>(page: Page, method: "post" | "patch", url: string, data?: unknown): Promise<T> {
  const response = await page.request[method](url, data ? { data } : undefined)
  await expectApiOk(response, `${method} ${url}`)
  return (await response.json()) as T
}

function idOf(json: any, key: string): string {
  const id = json?.[key]?.id ?? json?.data?.id ?? json?.id
  if (!id) throw new Error(`no id in ${JSON.stringify(json).slice(0, 300)}`)
  return id
}

async function tryStep(name: string, fn: () => Promise<void>) {
  try {
    await fn()
  } catch (error) {
    console.log(`skipped ${name}: ${(error as Error).message.split("\n")[0]}`)
  }
}

test("section order screenshots", async ({ page, browser }) => {
  const t = generateTestId()
  await devLogin(page, `order-shots-${t}@example.com`, `Order Shots ${t}`)
  const created = await page.request.post("/api/workspaces", { data: { name: `Order Shots ${t}` } })
  await expectApiOk(created, "create workspace")
  const ws = ((await created.json()) as { workspace: { id: string } }).workspace.id
  await waitForWorkspaceProvisioned(page, ws)
  const channel = async (slug: string) =>
    idOf(await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug, visibility: "public" }), "stream")
  const say = async (p: Page, streamId: string, content: string) =>
    idOf(await api(p, "post", `/api/workspaces/${ws}/messages`, { streamId, content }), "message")

  const zulu = await channel(`zulu-${t}`)
  const alpha = await channel(`alpha-${t}`)
  const mike = await channel(`mike-${t}`)
  const echo = await channel(`echo-${t}`)
  const yankee = await channel(`yankee-${t}`)
  const bravo = await channel(`bravo-${t}`)
  const kilo = await channel(`kilo-${t}`)
  await say(page, kilo, "Oldest")
  await say(page, alpha, "Kickoff")
  await say(page, yankee, "Middle")
  await say(page, bravo, "Newer")
  await say(page, echo, "Notes")
  await say(page, mike, "Deploy checklist")
  await say(page, zulu, "Latest thing")

  const other = await loginInNewContext(browser, `order-shots-b-${t}@example.com`, `Order Shots B ${t}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${ws}/join`, { data: { role: "member", name: `Maja ${t}` } }),
    "join workspace"
  )
  for (const s of [mike, echo]) {
    await expectApiOk(await other.page.request.post(`/api/workspaces/${ws}/streams/${s}/join`, { data: {} }), "join")
  }
  await say(other.page, echo, "Can you look at this?")
  await say(other.page, mike, "Staging is green")

  await api(page, "patch", `/api/workspaces/${ws}/sidebar-config`, {
    basePreset: "all",
    sections: [
      { id: "unread", spec: { kind: "unread" } },
      { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
      { id: "channels", spec: { kind: "type", streamType: "channel" } },
      { id: "dms", spec: { kind: "type", streamType: "dm" } },
    ],
  })

  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 1250 } })
  const dp = await desk.newPage()
  const logConfig = (who: string, pg: Page) => {
    pg.on("response", async (r) => {
      if (!r.url().includes("sidebar-config") || r.request().method() !== "PATCH") return
      console.log("RES", who, r.status(), r.request().postData()?.slice(0, 400), "=>", (await r.text().catch(() => "")).slice(0, 400))
    })
  }
  logConfig("desk", dp)
  await dp.goto(`/w/${ws}/s/${alpha}`)
  const nav = dp.getByRole("navigation", { name: "Sidebar navigation" })
  await expect(nav.locator(`a[href$='/s/${zulu}']`).first()).toBeAttached({ timeout: 180_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 60_000 }).catch(() => {})
  await dp.waitForTimeout(1500)
  await nav.screenshot({ path: `${OUT}/desktop-default.png` })

  // The menu portals outside the sidebar, so shoot the page region around it.
  // The modal menu aria-hides the nav, so measure it before any menu opens.
  const navWidth = (await nav.boundingBox())!.width
  const shot = async (name: string) => {
    await dp.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: navWidth + 230, height: 1150 } })
  }
  const menu = (label: string) => dp.getByRole("menu", { name: `${label} view options` })

  await tryStep("desktop menu", async () => {
    await nav.getByRole("heading", { name: "Channels" }).hover()
    await nav.getByRole("button", { name: "Channels view options" }).click({ timeout: 60_000 })
    await dp.waitForTimeout(400)
    await shot("desktop-menu")
    await menu("Channels").getByRole("menuitemradio", { name: "Latest activity" }).click()
    await dp.waitForTimeout(600)
    await shot("desktop-menu-activity")
    await menu("Channels").getByRole("menuitemradio", { name: "Latest activity" }).click()
    await dp.waitForTimeout(600)
    await shot("desktop-menu-activity-reversed")
    await dp.keyboard.press("Escape")
    await nav.getByRole("heading", { name: "Inbox" }).hover()
    await nav.getByRole("button", { name: "Inbox view options" }).click({ timeout: 60_000 })
    await dp.waitForTimeout(400)
    await shot("desktop-menu-inbox")
    await dp.keyboard.press("Escape")
  })

  const phone = await browser.newContext({ storageState, viewport: PHONE, isMobile: true, hasTouch: true })
  const pp = await phone.newPage()
  logConfig("phone", pp)
  await pp.goto(`/w/${ws}/s/${alpha}`)
  const toggles = pp.getByRole("button", { name: "Pin sidebar" })
  await expect(toggles.first()).toBeAttached({ timeout: 180_000 })
  await pp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 60_000 }).catch(() => {})
  for (let i = 0; i < (await toggles.count()); i += 1) {
    const box = await toggles.nth(i).boundingBox()
    if (box && box.x >= 0 && box.x + box.width <= PHONE.width) {
      await toggles.nth(i).click()
      break
    }
  }
  await pp.waitForTimeout(1000)
  await pp.screenshot({ path: `${OUT}/phone-sidebar.png` })
  await tryStep("phone sheet", async () => {
    await pp.getByRole("button", { name: "Channels view options" }).click({ timeout: 60_000 })
    await pp.waitForTimeout(800)
    await pp.screenshot({ path: `${OUT}/phone-sheet.png` })
    await pp.getByRole("radio", { name: "A–Z" }).tap()
    await expect(pp.getByRole("radio", { name: "A–Z" })).toHaveAttribute("aria-checked", "true", { timeout: 30_000 })
    await pp.waitForTimeout(600)
    await pp.screenshot({ path: `${OUT}/phone-sheet-az.png` })
    await pp.getByRole("radio", { name: "A–Z" }).tap()
    await expect(pp.getByRole("radio", { name: "A–Z, reversed" })).toBeVisible({ timeout: 30_000 })
    await pp.waitForTimeout(600)
    await pp.screenshot({ path: `${OUT}/phone-sheet-reversed.png` })
  })

  await tryStep("recent", async () => {
    await api(page, "patch", `/api/workspaces/${ws}/sidebar-config`, {
      basePreset: "smart",
      sections: [
        { id: "recent", spec: { kind: "smart", bucket: "recent" } },
        { id: "other", spec: { kind: "smart", bucket: "other" } },
      ],
    })
    await dp.keyboard.press("Escape")
    await dp.reload()
    await expect(nav.getByRole("heading", { name: "Recent" })).toBeVisible({ timeout: 180_000 })
    await expect(nav.locator(`a[href$='/s/${zulu}']`).first()).toBeAttached({ timeout: 180_000 })
    await dp.waitForTimeout(1500)
    await nav.getByRole("heading", { name: "Recent" }).hover()
    await nav.getByRole("button", { name: "Recent view options" }).click({ timeout: 60_000 })
    await dp.waitForTimeout(400)
    await shot("desktop-menu-recent")
  })
})
