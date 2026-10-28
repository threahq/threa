import { test, expect, type Page } from "@playwright/test"
import {
  createChannelViaApi,
  createDocViaApi,
  expectApiOk,
  loginAndCreateWorkspace,
  workspaceIdFromUrl,
  pane,
  docEditor,
  anchorRow,
  docChip,
  openChannel,
  renameDoc,
} from "./helpers"

/**
 * A doc chip points at a doc from a message or from another doc. Picking one with `/docs` in a channel composer
 * sends a chip that opens the doc pane; pasting a doc URL into a doc links the two, and the target lists the
 * source under "Linked from", opening it on the block that holds the link. `/doc <title>` creates a titled doc in
 * the stream composed in and links it in place.
 */

test.describe.configure({ timeout: 120_000 })

function docUpdatePosted(page: Page, docId: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname.endsWith(`/docs/${docId}/updates`)
  )
}

test.describe("Doc chips", () => {
  test("should send a doc chip that opens the doc pane when a doc is picked with /docs in a channel", async ({
    page,
  }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-chip")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `chips-${testId}`, "private")
    const docId = await createDocViaApi(page, workspaceId, channelId)
    const title = `Runbook ${testId}`
    await renameDoc(page, workspaceId, docId, title)

    await openChannel(page, workspaceId, channelId)
    const composer = pane(page, channelId).locator("[contenteditable='true']").last()
    await composer.click()
    await page.keyboard.type(`/docs Runbook ${testId.slice(0, 4)}`)
    const option = page.getByRole("listbox", { name: "Doc suggestions" }).getByRole("option").filter({ hasText: title })
    await expect(option).toBeVisible({ timeout: 10000 })
    await page.keyboard.press("Enter")
    await expect(docChip(composer)).toContainText(title)
    await page.keyboard.press("Enter")

    const sentChip = docChip(page.locator(`[data-stream-scroller="${channelId}"]`)).filter({ hasText: title })
    await expect(sentChip).toBeVisible({ timeout: 15000 })
    await sentChip.click()
    await expect(pane(page, docId)).toBeVisible({ timeout: 15000 })
    await expect(docEditor(page, docId)).toBeAttached({ timeout: 15000 })
  })

  test("should create a titled doc, link it in the composer and open it beside the channel when /doc is given a title", async ({
    page,
  }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-create")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `create-${testId}`, "private")
    const title = `Findings ${testId}`

    // An empty channel has no scroller yet, so its composer marks it as open.
    await page.goto(`/w/${workspaceId}/s/${channelId}`)
    const composer = pane(page, channelId).locator("[contenteditable='true']").last()
    await expect(composer).toBeVisible({ timeout: 20000 })
    await composer.click()
    await page.keyboard.type(`/doc ${title}`)
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/workspaces/${workspaceId}/streams`
    )
    await expect(
      page.getByRole("listbox", { name: "Doc suggestions" }).getByRole("option").filter({ hasText: "New doc" })
    ).toBeVisible()
    await page.keyboard.press("Enter")
    const response = await created
    await expectApiOk(response, "Create doc")
    const { stream } = (await response.json()) as { stream: { id: string; type: string; displayName: string } }

    expect({ type: stream.type, displayName: stream.displayName }).toEqual({ type: "doc", displayName: title })
    await expect(docChip(composer)).toContainText(title)
    await expect(composer).not.toContainText("/doc")
    await expect(pane(page, stream.id)).toBeVisible({ timeout: 15000 })
    await expect(pane(page, channelId)).toBeVisible()
  })

  test("should list the linking doc under Linked from and land on its chip when a doc URL is pasted into another doc", async ({
    page,
  }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-backlink")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `links-${testId}`, "private")
    const docA = await createDocViaApi(page, workspaceId, channelId)
    const docB = await createDocViaApi(page, workspaceId, channelId)
    const titleA = `Source ${testId}`
    const titleB = `Target ${testId}`
    await renameDoc(page, workspaceId, docA, titleA)
    await renameDoc(page, workspaceId, docB, titleB)

    await openChannel(page, workspaceId, channelId)
    await anchorRow(page, docA).click()
    const editorA = docEditor(page, docA)
    await expect(editorA).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await editorA.click()
    // Enough lines that the chip's block starts below the fold, so landing on it has to scroll.
    for (let line = 1; line <= 40; line++) await page.keyboard.type(`Line ${line}\n`)
    await page.keyboard.type("See ")

    const url = new URL(`/w/${workspaceId}/s/${docB}`, page.url()).toString()
    const persisted = docUpdatePosted(page, docA)
    await editorA.evaluate((el, value) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", value)
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }))
    }, url)
    await expect(docChip(editorA)).toContainText(titleB, { timeout: 10000 })
    // A boundary (Enter) flushes the pending update rather than waiting on the debounce.
    await page.keyboard.press("Enter")
    await expectApiOk(await persisted, "Persist doc A")
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${docB}/backlinks`)
        return response.ok() ? ((await response.json()) as { backlinks: Array<{ docId: string }> }).backlinks : []
      })
      .toEqual([expect.objectContaining({ docId: docA })])

    await anchorRow(page, docB).click()
    const backlinks = pane(page, docB).locator('section[aria-labelledby="doc-backlinks-heading"]')
    await expect(backlinks).toContainText("Linked from", { timeout: 15000 })
    const backlink = docChip(backlinks).filter({ hasText: titleA })
    await expect(backlink).toBeVisible()
    await backlink.click()

    await expect(docEditor(page, docA)).toBeAttached({ timeout: 15000 })
    // The highlight clears after 1.5 s, so it is checked first and within that window.
    await expect(
      docEditor(page, docA)
        .locator(":scope > .bg-primary\\/10")
        .filter({ has: page.locator('[data-type="doc-chip"]') })
    ).toHaveCount(1, { timeout: 1200 })
    await expect(docChip(docEditor(page, docA)).filter({ hasText: titleB })).toBeInViewport()
  })
})
