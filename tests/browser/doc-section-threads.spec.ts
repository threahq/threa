import { test, expect, type Browser, type Page, type Locator } from "@playwright/test"
import {
  expectApiOk,
  loginAndCreateWorkspace,
  loginInNewContext,
  sendPanelReply,
  waitForRealThreadPanel,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * A doc block carries its own thread: the gutter opens it, both members see its reply count live,
 * and cutting the block to the end of the doc takes the thread with it.
 */

test.describe.configure({ timeout: 150_000 })

const pane = (page: Page, id: string): Locator => page.locator(`[data-panel-tab="${id}"]`)
const docEditor = (page: Page, docId: string): Locator => pane(page, docId).locator(".ProseMirror")
const anchorRow = (page: Page, docId: string): Locator => page.locator(`a[data-doc-id="${docId}"]`)
const blocks = (page: Page, docId: string): Locator => docEditor(page, docId).locator(":scope > p")
const commentLink = (page: Page, docId: string): Locator =>
  pane(page, docId).getByRole("link", { name: "Comment on this block" })
const threadChip = (page: Page, docId: string): Locator =>
  pane(page, docId).getByRole("link", { name: /^\d+ comments? on this block$/ })
const modifier = process.platform === "darwin" ? "Meta" : "Control"

async function createChannelViaApi(page: Page, workspaceId: string, slug: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "public" },
  })
  await expectApiOk(response, "Create public channel")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function createDoc(page: Page, workspaceId: string, hostId: string): Promise<string> {
  const response = await page.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "doc", parentStreamId: hostId },
  })
  await expectApiOk(response, "Create doc")
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function joinWorkspace(browser: Browser, workspaceId: string, prefix: string, testId: string) {
  const email = `${prefix}-${testId}@example.com`
  const name = `${prefix} ${testId}`
  const user = await loginInNewContext(browser, email, name)
  await expectApiOk(
    await user.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member", name } }),
    `${prefix} joins workspace`
  )
  return { ...user, email, name }
}

async function userIdByEmail(page: Page, workspaceId: string, email: string): Promise<string> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(response, "Get workspace bootstrap")
  const body = (await response.json()) as { data: { users: Array<{ id: string; email: string }> } }
  const user = body.data.users.find((candidate) => candidate.email === email)
  if (!user) throw new Error(`No workspace user for ${email}`)
  return user.id
}

async function openChannel(page: Page, workspaceId: string, streamId: string): Promise<void> {
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await expect(page.locator(`[data-stream-scroller="${streamId}"]`)).toBeVisible({ timeout: 20000 })
}

async function typeAtEnd(page: Page, editor: Locator, text: string): Promise<void> {
  await editor.click()
  await page.keyboard.press("ControlOrMeta+End")
  await page.keyboard.type(text)
}

async function docThreadIds(page: Page, workspaceId: string, docId: string): Promise<string[]> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${docId}/threads`)
  await expectApiOk(response, "List doc threads")
  return ((await response.json()) as { threads: Array<{ threadId: string }> }).threads.map((t) => t.threadId)
}

async function savedSections(page: Page, workspaceId: string, docId: string): Promise<string[]> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${docId}`)
  if (!response.ok()) return []
  const body = (await response.json()) as { sections: Array<{ blockId: string; markdown: string }> }
  return body.sections.map((section) => section.markdown)
}

/** Top of `chip` lines up with top of `block`: the gutter places each control at its block's offset. */
async function expectBeside(chip: Locator, block: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        const [a, b] = [await chip.boundingBox(), await block.boundingBox()]
        return a && b ? Math.abs(a.y - b.y) : Infinity
      },
      { timeout: 15000, message: "the chip should sit beside its block" }
    )
    .toBeLessThanOrEqual(4)
}

test.describe("Doc section threads", () => {
  test("should open a thread from a block's gutter, count replies live and keep the thread through cut and paste", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    const { testId } = await loginAndCreateWorkspace(owner, "doc-threads")
    const workspaceId = workspaceIdFromUrl(owner)
    const channelId = await createChannelViaApi(owner, workspaceId, `doc-threads-${testId}`)
    const docId = await createDoc(owner, workspaceId, channelId)
    const member = await joinWorkspace(browser, workspaceId, "doc-threads-member", testId)

    try {
      await expectApiOk(
        await owner.request.post(`/api/workspaces/${workspaceId}/streams/${channelId}/members`, {
          data: { memberId: await userIdByEmail(owner, workspaceId, member.email) },
        }),
        "Add member to channel"
      )

      await openChannel(owner, workspaceId, channelId)
      await anchorRow(owner, docId).click()
      const ownerEditor = docEditor(owner, docId)
      await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

      await typeAtEnd(owner, ownerEditor, "First block")
      await owner.keyboard.press("Enter")
      await owner.keyboard.type("Second block")
      await expect(blocks(owner, docId)).toHaveText(["First block", "Second block"])
      // The quote reads the saved section, so the block's last keystrokes must be saved before it opens.
      await expect
        .poll(() => savedSections(owner, workspaceId, docId), { timeout: 15000 })
        .toEqual(["First block", "Second block"])

      const second = blocks(owner, docId).nth(1)
      // The Comment link renders only once the server has stamped the block's id.
      await expect
        .poll(
          async () => {
            await second.hover()
            return commentLink(owner, docId).isVisible()
          },
          { timeout: 20000, message: "the second block should get an id and a Comment link" }
        )
        .toBe(true)
      await expectBeside(commentLink(owner, docId), second)
      await commentLink(owner, docId).click()

      const draftPane = owner.locator("[data-panel-tab^='draft:']")
      await expect(draftPane).toContainText("Second block", { timeout: 15000 })
      await sendPanelReply(owner, "Comment one")
      await waitForRealThreadPanel(owner)

      const ownerChip = threadChip(owner, docId)
      await expect(ownerChip).toHaveText("1", { timeout: 15000 })
      await expect(ownerChip).toHaveAccessibleName("1 comment on this block")
      await expectBeside(ownerChip, second)
      const threadIds = await docThreadIds(owner, workspaceId, docId)
      expect(threadIds).toHaveLength(1)
      const [threadId] = threadIds
      expect(decodeURIComponent((await ownerChip.getAttribute("href")) ?? "")).toContain(threadId)

      await openChannel(member.page, workspaceId, channelId)
      await anchorRow(member.page, docId).click()
      const memberEditor = docEditor(member.page, docId)
      await expect(memberEditor).toContainText("Second block", { timeout: 15000 })
      const memberChip = threadChip(member.page, docId)
      await expect(memberChip).toHaveText("1", { timeout: 15000 })
      await memberChip.click()
      await expect(pane(member.page, threadId)).toContainText("Second block", { timeout: 15000 })
      await expect(pane(member.page, threadId)).toContainText("Comment one")
      await sendPanelReply(member.page, "Comment two")
      await expect(pane(member.page, threadId)).toContainText("Comment two", { timeout: 15000 })

      await expect(ownerChip).toHaveText("2", { timeout: 15000 })
      await expect(ownerChip).toHaveAccessibleName("2 comments on this block")

      // Cut from the end of block 1 through the end of block 2, so the paragraph node itself leaves the doc.
      const first = blocks(owner, docId).first()
      const firstBox = (await first.boundingBox())!
      await owner.mouse.click(firstBox.x + firstBox.width - 2, firstBox.y + firstBox.height / 2)
      await owner.keyboard.press("End")
      await owner.keyboard.press("Shift+ArrowDown")
      await owner.keyboard.press("Shift+End")
      await expect.poll(() => owner.evaluate(() => window.getSelection()?.toString().trim())).toBe("Second block")
      await owner.waitForTimeout(100)
      await owner.keyboard.press(`${modifier}+x`)
      await expect(blocks(owner, docId)).toHaveText(["First block"])
      await owner.keyboard.press(`${modifier}+End`)
      await expect(blocks(owner, docId)).toHaveText(["First block"])
      await owner.keyboard.press("Enter")
      await owner.keyboard.press(`${modifier}+v`)

      await expect(blocks(owner, docId).last()).toHaveText("Second block", { timeout: 15000 })
      const texts = await blocks(owner, docId).allTextContents()
      expect(texts[0]).toBe("First block")
      expect(texts.at(-1)).toBe("Second block")
      expect(texts.length).toBeGreaterThan(1)

      await expect(ownerChip).toHaveCount(1)
      await expect(ownerChip).toHaveText("2")
      await expectBeside(ownerChip, blocks(owner, docId).last())
      expect(decodeURIComponent((await ownerChip.getAttribute("href")) ?? "")).toContain(threadId)
      await expect(memberChip).toHaveText("2", { timeout: 15000 })
      await expectBeside(memberChip, blocks(member.page, docId).last())
    } finally {
      await ownerContext.close()
      await member.context.close()
    }
  })
})
