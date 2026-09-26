import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 240_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/held-threads-shots"

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

test("held thread dims after read, Clear removes it", async ({ page, browser }) => {
  await loginAndCreateWorkspace(page, "held-shots")
  const ws = page.url().match(/\/w\/([^/?]+)/)![1]
  const t = Date.now().toString(36)
  await page.goto("about:blank")
  const say = async (p: Page, streamId: string, content: string) =>
    idOf(await api(p, "post", `/api/workspaces/${ws}/messages`, { streamId, content }), "message")

  const design = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `design-${t}`, visibility: "public" }),
    "stream"
  )
  const other = await loginInNewContext(browser, `held-b-${t}@example.com`, `Held B ${t}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${ws}/join`, { data: { role: "member", name: `Maja ${t}` } }),
    "join workspace"
  )
  await expectApiOk(await other.page.request.post(`/api/workspaces/${ws}/streams/${design}/join`, { data: {} }), "join")
  const m = await say(other.page, design, "Question on the divider")
  const thread = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "thread", parentStreamId: design, parentAnchorId: m }),
    "stream"
  )
  await say(page, thread, "Which divider?")
  await say(other.page, thread, "Should the New label sit on the baseline?")
  const random = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `random-${t}`, visibility: "public" }),
    "stream"
  )
  await say(page, random, "Lunch?")

  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 860 } })
  const dp = await desk.newPage()
  await dp.goto(`/w/${ws}/s/${random}`)
  const row = dp.locator(`a[href$='/s/${thread}']`).first()
  await expect(row).toBeAttached({ timeout: 30_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 5000 }).catch(() => {})
  await dp.waitForTimeout(1500)
  await dp.screenshot({ path: `${OUT}/1-unread.png` })

  await row.click()
  await dp.waitForTimeout(2500)
  await dp.locator(`a[href$='/s/${random}']`).first().click()
  await dp.waitForTimeout(2000)
  await expect(row).toBeAttached()
  await dp.mouse.move(1200, 20)
  await dp.screenshot({ path: `${OUT}/2-held-dimmed.png` })

  await row.hover()
  const clear = dp.getByRole("button", { name: "Clear from sidebar" })
  await expect(clear).toBeVisible({ timeout: 5000 })
  await dp.waitForTimeout(400)
  await dp.screenshot({ path: `${OUT}/3-held-hover-clear.png` })

  await clear.click()
  await expect(row).not.toBeAttached({ timeout: 5000 })
  await dp.mouse.move(1200, 20)
  await dp.waitForTimeout(500)
  await dp.screenshot({ path: `${OUT}/4-cleared.png` })
  await desk.close()
  await other.context.close()
})
