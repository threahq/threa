import { test, expect, type Page, type Locator } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"

/**
 * A doc's title is its stream's name: a member renames it in the field above
 * the body, the namer titles an untitled doc from what was written, and a
 * human title can be handed back to the namer.
 */

test.describe.configure({ timeout: 150_000 })

const STUB_DOC_TITLE = "Generated doc title"

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-tab="${id}"]`)
const docEditor = (page: Page, docId: string): Locator => pane(page, docId).locator(".ProseMirror")
const titleInput = (page: Page, docId: string): Locator => pane(page, docId).getByRole("textbox", { name: "Doc title" })
const anchorRow = (page: Page, docId: string): Locator => page.locator(`a[data-doc-id="${docId}"]`)

async function createChannelViaApi(page: Page, workspaceId: string, slug: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "private" },
  })
  await expectApiOk(response, "Create channel")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function createDoc(page: Page, workspaceId: string, hostId: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "doc", parentStreamId: hostId },
  })
  await expectApiOk(response, "Create doc")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function openDoc(page: Page, workspaceId: string, channelId: string, docId: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/s/${channelId}`)
  await expect(page.locator(`[data-stream-scroller="${channelId}"]`)).toBeVisible({ timeout: 20000 })
  await anchorRow(page, docId).click()
  await expect(docEditor(page, docId)).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
}

async function setUp(page: Page, prefix: string) {
  const { testId } = await loginAndCreateWorkspace(page, prefix)
  const workspaceId = workspaceIdFromUrl(page)
  const channelId = await createChannelViaApi(page, workspaceId, `${prefix}-${testId}`)
  const docId = await createDoc(page, workspaceId, channelId)
  await openDoc(page, workspaceId, channelId, docId)
  return { workspaceId, channelId, docId }
}

async function writeParagraphs(page: Page, docId: string, paragraphs: string[]): Promise<void> {
  await docEditor(page, docId).click()
  for (const [index, text] of paragraphs.entries()) {
    if (index > 0) await page.keyboard.press("Enter")
    await page.keyboard.type(text)
  }
}

test.describe("Doc title", () => {
  test("should rename a doc from its title field and keep the name across a reload", async ({ page }) => {
    const { docId } = await setUp(page, "doc-title-rename")
    const input = titleInput(page, docId)
    await expect(input).toHaveAttribute("placeholder", "Untitled")
    await expect(input).toHaveValue("")

    await input.fill("Launch plan")
    await input.press("Enter")

    await expect(pane(page, docId).getByRole("heading", { name: "Launch plan", level: 1 })).toBeVisible({
      timeout: 15000,
    })
    await expect(docEditor(page, docId)).toBeFocused()

    await page.reload()
    await expect(titleInput(page, docId)).toHaveValue("Launch plan", { timeout: 20000 })
  })

  test("should title an untitled doc from its body once the writer pauses", async ({ page }) => {
    const { docId } = await setUp(page, "doc-title-auto")
    await writeParagraphs(page, docId, [
      "Launch checklist for the spring release",
      "Owners and dates",
      "Risks we are watching",
    ])

    await expect(titleInput(page, docId)).toHaveValue(STUB_DOC_TITLE, { timeout: 25000 })
  })

  test("should hand a human title back to the namer when the member regenerates it", async ({ page }) => {
    const { docId } = await setUp(page, "doc-title-regen")
    await writeParagraphs(page, docId, ["Launch checklist for the spring release"])
    const input = titleInput(page, docId)
    await input.fill("Launch plan")
    await input.press("Enter")
    await expect(pane(page, docId).getByRole("heading", { name: "Launch plan", level: 1 })).toBeVisible({
      timeout: 15000,
    })

    const regenerate = pane(page, docId).getByRole("button", { name: "Regenerate title" })
    await expect(regenerate).toBeVisible()
    await regenerate.click()

    await expect(input).toHaveValue(STUB_DOC_TITLE, { timeout: 25000 })
    await expect(regenerate).toHaveCount(0)
  })
})
