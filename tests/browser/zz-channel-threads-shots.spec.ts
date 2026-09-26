import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 240_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/channel-threads-shots"
const BEFORE = process.env.SHOTS_BEFORE === "1"

async function api<T = any>(page: Page, method: "post" | "get" | "patch", url: string, data?: unknown): Promise<T> {
  const response = await page.request[method](url, data ? { data } : undefined)
  await expectApiOk(response, `${method} ${url}`)
  return (await response.json()) as T
}

function idOf(json: any, key: string): string {
  const id = json?.[key]?.id ?? json?.data?.id ?? json?.id
  if (!id) throw new Error(`no id in ${JSON.stringify(json).slice(0, 300)}`)
  return id
}

test("channel threads: menu entry, explorer filter, panel rows", async ({ page, browser }) => {
  await loginAndCreateWorkspace(page, "chthreads-shots")
  const ws = page.url().match(/\/w\/([^/?]+)/)![1]
  const t = Date.now().toString(36)
  await page.goto("about:blank")
  const say = async (p: Page, streamId: string, content: string) =>
    idOf(await api(p, "post", `/api/workspaces/${ws}/messages`, { streamId, content }), "message")

  const design = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `design-${t}`, visibility: "public" }),
    "stream"
  )
  const other = await loginInNewContext(browser, `ch-b-${t}@example.com`, `Ch B ${t}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${ws}/join`, { data: { role: "member", name: `Maja ${t}` } }),
    "join workspace"
  )
  await expectApiOk(await other.page.request.post(`/api/workspaces/${ws}/streams/${design}/join`, { data: {} }), "join")

  const m1 = await say(page, design, "Proposal: move the divider to the baseline")
  const t1 = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "thread", parentStreamId: design, parentAnchorId: m1 }),
    "stream"
  )
  await say(page, t1, "Mock is in Figma")
  await say(other.page, t1, "Looks right to me, ship it")
  await say(other.page, t1, "One nit on the spacing though")

  const m2 = await say(other.page, design, "Release notes draft for Friday")
  const t2 = idOf(
    await api(other.page, "post", `/api/workspaces/${ws}/streams`, {
      type: "thread",
      parentStreamId: design,
      parentAnchorId: m2,
    }),
    "stream"
  )
  await say(other.page, t2, "First pass is up")
  await say(page, t2, "Read it, all good")

  const random = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `random-${t}`, visibility: "public" }),
    "stream"
  )
  await say(page, random, "Lunch?")

  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 860 } })
  const dp = await desk.newPage()
  await dp.goto(`/w/${ws}/s/${random}`)
  const designRow = dp.locator(`a[href$='/s/${design}']`).first()
  await expect(designRow).toBeAttached({ timeout: 30_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 5000 }).catch(() => {})
  await dp.waitForTimeout(1500)

  if (!BEFORE) {
    await designRow.hover()
    await dp.waitForTimeout(1200)
    await dp.screenshot({ path: `${OUT}/1-hover-card.png` })
    await dp.mouse.move(1200, 20)
    await dp.waitForTimeout(600)

    await designRow.click({ button: "right" })
    await expect(dp.getByRole("menuitem", { name: "Threads" })).toBeVisible({ timeout: 5000 })
    await dp.waitForTimeout(300)
    await dp.screenshot({ path: `${OUT}/2-row-menu.png` })
    await dp.getByRole("menuitem", { name: "Threads" }).click()
    await expect(dp).toHaveURL(new RegExp(`/streams/threads\\?in=${design}`))
    await dp.mouse.move(1200, 600)
    await dp.waitForTimeout(1500)
    await dp.screenshot({ path: `${OUT}/3-explorer-filtered.png` })
  }

  await dp.goto(`/w/${ws}/s/${design}?context=thread`)
  await dp.waitForTimeout(3500)
  await dp.screenshot({ path: `${OUT}/${BEFORE ? "0-before-panel" : "4-panel"}.png` })
  await desk.close()
  await other.context.close()
})
