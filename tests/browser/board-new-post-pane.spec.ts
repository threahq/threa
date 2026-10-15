import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * "New post" opens its draft in a pane of its own (`compose:board:new%2Dpost`), in focus,
 * with the target picker in the pane's header. Phones keep the sheet.
 */

test.describe.configure({ timeout: 120_000 })

const panelParam = (page: Page) => new URL(page.url()).searchParams.get("panel")
// The draft key's "-" is escaped in its pane id, since "-" separates the layout's sections.
const NEW_POST_PANE = "compose:board:new%2Dpost"
const newPostPane = (page: Page) => page.locator(`[data-panel-tab="${NEW_POST_PANE}"]`)

async function openBoard(page: Page, search = "lens=all") {
  await loginAndCreateWorkspace(page, "board-new-post")
  const slug = `post-${Date.now().toString(36)}`
  await createChannel(page, slug)
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  await page.goto(`/w/${workspaceId}/board?${search}`)
  return slug
}

async function postFromPane(page: Page, slug: string, text: string) {
  const editor = newPostPane(page).getByRole("textbox", { name: "Expanded message editor" })
  await expect(editor).toBeFocused()
  await page.keyboard.type(text)
  await newPostPane(page).locator("header").getByRole("combobox").click()
  await page.getByRole("option", { name: slug }).first().click()
  await expect(newPostPane(page).locator("header").getByRole("combobox")).toContainText(slug)
  await editor.click()
  await page.keyboard.press("ControlOrMeta+Enter")
}

test("should write a new post in a focused pane, pick its target in the pane's header, and close the pane on send", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const slug = await openBoard(page)

  const newPost = page.getByRole("link", { name: "New post" })
  // A link, so it drags into the layout like any pane link.
  expect(new URL((await newPost.getAttribute("href"))!, page.url()).searchParams.get("panel")).toBe(
    `${NEW_POST_PANE}**`
  )
  await newPost.click()

  await expect.poll(() => panelParam(page)).toBe(`${NEW_POST_PANE}**`)
  await postFromPane(page, slug, "Posted from its own pane")
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(newPostPane(page)).toHaveCount(0)
  await expect(page.locator('[data-panel-tab="page:board"]').getByText("Posted from its own pane")).toBeVisible()
})

test("should close the pane and show the post on All when it is sent from a filtered board", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  const slug = await openBoard(page, "lens=all&is=scratchpad")

  await page.getByRole("link", { name: "New post" }).click()
  await postFromPane(page, slug, "Posted past the filter")

  await expect.poll(() => new URL(page.url()).searchParams.get("is")).toBeNull()
  await expect.poll(() => panelParam(page)).toBeNull()
  await expect(newPostPane(page)).toHaveCount(0)
  await expect(page.locator('[data-panel-tab="page:board"]').getByText("Posted past the filter")).toBeVisible()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("should open a new post in the sheet", async ({ page }) => {
    await openBoard(page)
    await page.getByRole("button", { name: "New post" }).click()
    await expect(page.getByRole("dialog").getByRole("combobox")).toContainText("Post to…")
    expect(panelParam(page)).toBeNull()
  })
})
