import { test, expect, type Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk } from "./helpers"

test.describe.configure({ timeout: 240_000 })

const OUT = process.env.SHOTS_DIR ?? "/tmp/section-threads-shots"

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

test("section threads, reload card, explorer card", async ({ page, browser }) => {
  const owner = await loginAndCreateWorkspace(page, "sect-shots")
  const ws = page.url().match(/\/w\/([^/?]+)/)![1]
  const t = owner.testId
  await page.goto("about:blank")
  const say = async (p: Page, streamId: string, content: string) =>
    idOf(await api(p, "post", `/api/workspaces/${ws}/messages`, { streamId, content }), "message")
  const thread = async (p: Page, parentStreamId: string, parentAnchorId: string) =>
    idOf(await api(p, "post", `/api/workspaces/${ws}/streams`, { type: "thread", parentStreamId, parentAnchorId }), "stream")

  const design = idOf(
    await api(page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `design-${t}`, visibility: "public" }),
    "stream"
  )
  const m1 = await say(page, design, "Old kickoff notes")
  const readThread = await thread(page, design, m1)
  await say(page, readThread, "Settled last week, nothing new here")

  const other = await loginInNewContext(browser, `sect-shots-b-${t}@example.com`, `Sect Shots B ${t}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${ws}/join`, { data: { role: "member", name: `Maja ${t}` } }),
    "join workspace"
  )
  await expectApiOk(await other.page.request.post(`/api/workspaces/${ws}/streams/${design}/join`, { data: {} }), "join")
  const m2 = await say(other.page, design, "Question on the divider")
  const unreadThread = await thread(page, design, m2)
  await say(page, unreadThread, "Which divider?")
  await say(other.page, unreadThread, "Should the New label sit on the baseline?")
  for (let i = 1; i <= 4; i++) await say(other.page, design, `Update ${i}`)
  const random = idOf(
    await api(other.page, "post", `/api/workspaces/${ws}/streams`, { type: "channel", slug: `random-${t}`, visibility: "public" }),
    "stream"
  )
  await say(other.page, random, "Lunch?")

  const boot = await api(page, "get", `/api/workspaces/${ws}/bootstrap`)
  const b = boot.data ?? boot
  writeFileSync(`${OUT}/boot.json`, JSON.stringify({ threads: [readThread, unreadThread], streams: b.streams?.map((x: any) => ({ id: x.id, type: x.type, urgency: x.urgency })), unread: b.unreadCounts, keys: Object.keys(b) }, null, 1))
  const storageState = await page.context().storageState()
  const desk = await browser.newContext({ storageState, viewport: { width: 1280, height: 860 } })
  const dp = await desk.newPage()
  await dp.goto(`/w/${ws}/s/${random}`)
  await expect(dp.locator(`a[href$='/s/${design}']`).first()).toBeAttached({ timeout: 30_000 })
  await dp.getByRole("button", { name: "Dismiss getting started" }).click({ timeout: 5000 }).catch(() => {})
  await dp.waitForTimeout(2500)
  await dp.locator("aside, nav").first().screenshot({ path: `${OUT}/sidebar-threads.png` }).catch(async () => {
    await dp.screenshot({ path: `${OUT}/sidebar-threads.png` })
  })
  await dp.screenshot({ path: `${OUT}/sidebar-threads-full.png` })

  // Warm the card once, then leave the app while more messages land, then come back.
  await dp.locator(`a[href$='/s/${design}']`).first().hover()
  await expect(dp.locator("[data-radix-popper-content-wrapper]").getByText("Update 4")).toBeVisible({ timeout: 10_000 })
  await dp.goto("about:blank")
  for (let i = 5; i <= 9; i++) await say(other.page, design, `Update ${i}`)
  await dp.goto(`/w/${ws}/s/${random}`)
  await expect(dp.locator(`a[href$='/s/${design}']`).first()).toBeAttached({ timeout: 30_000 })
  await dp.waitForTimeout(2500)
  await dp.locator(`a[href$='/s/${design}']`).first().hover()
  await dp.waitForTimeout(150)
  await dp.screenshot({ path: `${OUT}/card-after-reload-150ms.png` })
  await dp.waitForTimeout(1500)
  await dp.screenshot({ path: `${OUT}/card-after-reload.png` })
  await dp.mouse.move(1200, 20)

  await dp.goto(`/w/${ws}/streams`)
  await expect(dp.getByRole("region", { name: "Most active" })).toBeVisible({ timeout: 15_000 })
  await dp.waitForTimeout(2000)
  await dp.locator("li", { hasText: `#random-${t}` }).last().hover()
  await dp.waitForTimeout(150)
  await dp.screenshot({ path: `${OUT}/explorer-hover-150ms.png` })
  await dp.waitForTimeout(1500)
  await dp.screenshot({ path: `${OUT}/explorer-hover.png` })
  await desk.close()
  await other.context.close()
})
