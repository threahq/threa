import { test, expect, type Page, type Locator } from "@playwright/test"
import {
  createChannelViaApi,
  createDocViaApi,
  expectApiOk,
  loginAndCreateWorkspace,
  userIdByEmail,
  workspaceIdFromUrl,
  pane,
  docEditor,
  anchorRow,
  openChannel,
  joinWorkspace,
} from "./helpers"

/**
 * A doc opens as a pane beside its host channel. Two members editing it
 * converge, a reload shows what was saved, a reader outside a public channel
 * gets the text without an editor, and a phone shows the doc full-screen.
 */

test.describe.configure({ timeout: 150_000 })

const presenceStack = (page: Page, docId: string): Locator => pane(page, docId).locator('[data-testid="doc-presence"]')

/** The doc's text without peers' caret labels, which y-prosemirror renders inside the editor. */
const docText = (editor: Locator): Promise<string> =>
  editor.evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement
    copy.querySelectorAll(".ProseMirror-yjs-cursor").forEach((caret) => caret.remove())
    return copy.textContent ?? ""
  })

/** Moves the caret to the end of the doc through ProseMirror's own keymap. */
async function moveCaretToEnd(page: Page, editor: Locator): Promise<void> {
  await editor.click()
  await page.keyboard.press("ControlOrMeta+End")
}

async function typeAtEnd(page: Page, editor: Locator, text: string): Promise<void> {
  await moveCaretToEnd(page, editor)
  await page.keyboard.type(text)
}

async function savedUpdateCount(page: Page, workspaceId: string, docId: string): Promise<number> {
  const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${docId}/updates?after=0`)
  return response.ok() ? ((await response.json()) as { updates: unknown[] }).updates.length : 0
}

/**
 * `RevealOnReady` hides a pane with opacity 0 on an ancestor, which `toBeVisible` ignores. The editor mounts
 * in the commit that reports ready, so once it is attached the reveal is a frame away; only the 3 s cap
 * would reveal it later than that.
 */
async function expectRevealed(editor: Locator): Promise<void> {
  await expect(editor).toBeAttached({ timeout: 15000 })
  await expect
    .poll(
      () =>
        editor.evaluate((el) => {
          let opacity = 1
          for (let node: Element | null = el; node; node = node.parentElement) {
            opacity *= Number(getComputedStyle(node).opacity)
          }
          return opacity
        }),
      { timeout: 750, message: "the doc pane should reveal as soon as the editor mounts, not at the reveal cap" }
    )
    .toBe(1)
}

function collectRevealFallbacks(page: Page): string[] {
  const messages: string[] = []
  page.on("console", (message) => {
    if (message.text().includes("[CoordinatedLoading] Revealing without")) messages.push(message.text())
  })
  return messages
}

test.describe("Doc pane", () => {
  test("should create a doc beside its channel, converge two members' edits and show who is in it", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    const { testId, name: ownerName } = await loginAndCreateWorkspace(owner, "doc-owner")
    const workspaceId = workspaceIdFromUrl(owner)
    const channelId = await createChannelViaApi(owner, workspaceId, `docs-${testId}`, "private")
    const member = await joinWorkspace(browser, workspaceId, "doc-member", testId)
    const revealFallbacks = [owner, member.page].map(collectRevealFallbacks)

    try {
      await expectApiOk(
        await owner.request.post(`/api/workspaces/${workspaceId}/streams/${channelId}/members`, {
          data: { memberId: await userIdByEmail(owner, workspaceId, member.email) },
        }),
        "Add member to channel"
      )

      await openChannel(owner, workspaceId, channelId)
      await openChannel(member.page, workspaceId, channelId)
      const created = owner.waitForResponse(
        (response) => response.request().method() === "POST" && /\/streams$/.test(new URL(response.url()).pathname)
      )
      await pane(owner, channelId).getByRole("button", { name: "Stream actions" }).first().click()
      await owner.getByRole("menuitem", { name: "New doc" }).click()
      const createdResponse = await created
      await expectApiOk(createdResponse, "New doc")
      const docId = ((await createdResponse.json()) as { stream: { id: string } }).stream.id

      await expect.poll(() => new URL(owner.url()).searchParams.get("panel")).toContain(docId)
      await expect(pane(owner, channelId)).toBeVisible()
      await expect(pane(owner, docId)).toContainText("Untitled", { timeout: 15000 })
      const ownerEditor = docEditor(owner, docId)
      await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
      await expect(pane(owner, docId).getByRole("button", { name: "Bold" })).toBeVisible()
      await expect(pane(member.page, channelId).getByRole("button", { name: "1 doc" })).toBeVisible({ timeout: 15000 })

      await typeAtEnd(owner, ownerEditor, "Rotation tracker")
      await owner.keyboard.press("Enter")
      await owner.keyboard.press("ControlOrMeta+b")
      await owner.keyboard.type("Keys")
      await owner.keyboard.press("ControlOrMeta+b")
      await expect(ownerEditor.locator("strong")).toHaveText("Keys")
      await owner.keyboard.press("Enter")

      const row = anchorRow(member.page, docId)
      await expect(row).toContainText("created a doc", { timeout: 15000 })
      await expect(row).toContainText("Untitled")
      await row.click()
      const memberEditor = docEditor(member.page, docId)
      await expectRevealed(memberEditor)
      await expect(memberEditor).toContainText("Rotation tracker", { timeout: 15000 })
      await expect(memberEditor.locator("strong")).toHaveText("Keys")
      await expect(memberEditor).toHaveAttribute("contenteditable", "true")

      await typeAtEnd(member.page, memberEditor, "AWS key rotated")

      const bothTexts = async () => [await docText(ownerEditor), await docText(memberEditor)]
      await expect
        .poll(
          async () => {
            const [a, b] = await bothTexts()
            return a === b && a.includes("Rotation tracker") && a.includes("AWS key rotated")
          },
          { timeout: 15000, message: "both editors should hold both edits" }
        )
        .toBe(true)

      await expect(ownerEditor.locator(".ProseMirror-yjs-cursor")).toContainText(member.name, { timeout: 10000 })
      await expect(presenceStack(owner, docId).getByRole("button", { name: member.name })).toBeVisible({
        timeout: 10000,
      })
      await expect(presenceStack(member.page, docId).getByRole("button", { name: ownerName })).toBeVisible({
        timeout: 10000,
      })
      await pane(owner, channelId).getByRole("button", { name: "1 doc" }).click()
      const docLink = owner.getByRole("menuitem", { name: /Untitled/ })
      await expect(docLink).toHaveAttribute("href", new RegExp(docId))
      await owner.keyboard.press("Escape")

      // Give the 400 ms debounce time to post before the reload drops the page; > 1 means both members' edits are saved.
      await expect.poll(() => savedUpdateCount(owner, workspaceId, docId)).toBeGreaterThan(1)
      await owner.reload()
      await expectRevealed(ownerEditor)
      await expect(ownerEditor).toContainText("Rotation tracker", { timeout: 20000 })
      await expect(ownerEditor).toContainText("AWS key rotated")

      await moveCaretToEnd(owner, ownerEditor)
      await owner.keyboard.press("Enter")
      await owner.keyboard.type("- [ ] revoke old key")
      const ownerTask = ownerEditor.locator("ul[data-type='taskList'] > li")
      await expect(ownerTask).toHaveCount(1)
      await expect(ownerTask).toContainText("revoke old key")
      await ownerTask.locator("input[type='checkbox']").check()
      await expect(ownerTask).toHaveAttribute("data-checked", "true")

      const memberTask = memberEditor.locator("ul[data-type='taskList'] > li")
      await expect(memberTask).toContainText("revoke old key", { timeout: 15000 })
      await expect(memberTask).toHaveAttribute("data-checked", "true", { timeout: 15000 })
      expect(revealFallbacks.flat()).toEqual([])

      await expect(presenceStack(owner, docId).getByRole("button", { name: member.name })).toBeVisible({
        timeout: 10000,
      })
      await pane(member.page, docId).getByRole("button", { name: "Close", exact: true }).click()
      await expect(pane(member.page, docId)).toHaveCount(0)
      await expect(presenceStack(owner, docId)).toHaveCount(0, { timeout: 10000 })
    } finally {
      await ownerContext.close()
      await member.context.close()
    }
  })

  test("should show a public channel's doc read-only to a workspace member outside the channel", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    const { testId } = await loginAndCreateWorkspace(owner, "doc-public")
    const workspaceId = workspaceIdFromUrl(owner)
    const channelId = await createChannelViaApi(owner, workspaceId, `public-docs-${testId}`, "public")
    const docId = await createDocViaApi(owner, workspaceId, channelId)
    const reader = await joinWorkspace(browser, workspaceId, "doc-reader", testId)

    try {
      await openChannel(owner, workspaceId, channelId)
      await anchorRow(owner, docId).click()
      await typeAtEnd(owner, docEditor(owner, docId), "Visible to the whole workspace")
      await expect.poll(() => savedUpdateCount(reader.page, workspaceId, docId)).toBeGreaterThan(0)

      await openChannel(reader.page, workspaceId, channelId)
      await anchorRow(reader.page, docId).click()
      const readerEditor = docEditor(reader.page, docId)
      await expect(readerEditor).toContainText("Visible to the whole workspace", { timeout: 15000 })
      await expect(readerEditor).toHaveAttribute("contenteditable", "false")
      await expect(pane(reader.page, docId).getByRole("button", { name: "Bold" })).toHaveCount(0)
      await pane(reader.page, docId).getByRole("button", { name: "Stream actions" }).first().click()
      await expect(reader.page.getByRole("menuitem", { name: "Copy link" })).toBeVisible()
      await expect(reader.page.getByRole("menuitem", { name: "Archive" })).toHaveCount(0)
    } finally {
      await ownerContext.close()
      await reader.context.close()
    }
  })

  test("should show the doc's channel in its header, and archive and unarchive it from its menu", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-archive")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `archive-docs-${testId}`, "private")
    const docId = await createDocViaApi(page, workspaceId, channelId)

    await openChannel(page, workspaceId, channelId)
    await anchorRow(page, docId).click()
    const docPane = pane(page, docId)
    const editor = docEditor(page, docId)
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await expect(docPane.locator("header").locator(`a[href*="/s/${channelId}"]`).first()).toContainText(
      `archive-docs-${testId}`
    )

    const archived = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/${docId}/archive`))
    await docPane.getByRole("button", { name: "Stream actions" }).first().click()
    await page.getByRole("menuitem", { name: "Archive" }).click()
    await expectApiOk(await archived, "Archive doc")
    await expect(docPane.getByText("Archived", { exact: true })).toBeVisible()
    await expect(editor).toHaveAttribute("contenteditable", "false")

    const unarchived = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith(`/${docId}/unarchive`)
    )
    await docPane.getByRole("button", { name: "Stream actions" }).first().click()
    await page.getByRole("menuitem", { name: "Unarchive" }).click()
    await expectApiOk(await unarchived, "Unarchive doc")
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
  })

  test("should merge edits made offline when the member reconnects, and ship edits from a pane closed offline", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    const { testId } = await loginAndCreateWorkspace(owner, "doc-offline")
    const workspaceId = workspaceIdFromUrl(owner)
    const channelId = await createChannelViaApi(owner, workspaceId, `offline-docs-${testId}`, "private")
    const member = await joinWorkspace(browser, workspaceId, "doc-offline-member", testId)
    const sentences = ["Shared line.", "Member offline words.", "Owner meanwhile.", "Typed then closed"]

    try {
      await expectApiOk(
        await owner.request.post(`/api/workspaces/${workspaceId}/streams/${channelId}/members`, {
          data: { memberId: await userIdByEmail(owner, workspaceId, member.email) },
        }),
        "Add member to channel"
      )
      const docId = await createDocViaApi(owner, workspaceId, channelId)

      await openChannel(owner, workspaceId, channelId)
      await anchorRow(owner, docId).click()
      const ownerEditor = docEditor(owner, docId)
      await expect(ownerEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

      await openChannel(member.page, workspaceId, channelId)
      await anchorRow(member.page, docId).click()
      const memberEditor = docEditor(member.page, docId)
      await expect(memberEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

      await typeAtEnd(owner, ownerEditor, "Shared line. ")
      await expect(memberEditor).toContainText("Shared line.", { timeout: 15000 })

      await member.page.context().setOffline(true)
      await typeAtEnd(member.page, memberEditor, "Member offline words. ")
      await typeAtEnd(owner, ownerEditor, "Owner meanwhile. ")
      await expect(memberEditor).toContainText("Member offline words.")

      await member.page.context().setOffline(false)
      await expect
        .poll(
          async () => {
            const [a, b] = [await docText(ownerEditor), await docText(memberEditor)]
            return a === b && sentences.slice(0, 3).every((sentence) => a.includes(sentence))
          },
          { timeout: 20000, message: "both editors should converge on the online and offline edits" }
        )
        .toBe(true)

      // No boundary after the last word: only closing the pane can hand it off.
      await member.page.context().setOffline(true)
      await typeAtEnd(member.page, memberEditor, "Typed then closed")
      await pane(member.page, docId).getByRole("button", { name: "Close", exact: true }).click()
      await expect(pane(member.page, docId)).toHaveCount(0)
      await member.page.context().setOffline(false)
      await expect(ownerEditor).toContainText("Typed then closed", { timeout: 20000 })

      await anchorRow(member.page, docId).click()
      for (const sentence of sentences) {
        await expect(memberEditor).toContainText(sentence, { timeout: 15000 })
      }
    } finally {
      await ownerContext.close()
      await member.context.close()
    }
  })

  test("should keep two tabs of one doc in step offline and send both tabs' edits once, after the leading tab closes", async ({
    page,
  }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-tabs")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `tab-docs-${testId}`, "private")
    const docId = await createDocViaApi(page, workspaceId, channelId)
    const second = await page.context().newPage()
    const [firstEditor, secondEditor] = [docEditor(page, docId), docEditor(second, docId)]
    for (const tab of [page, second]) {
      await openChannel(tab, workspaceId, channelId)
      await anchorRow(tab, docId).click()
    }
    await expect(firstEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await expect(secondEditor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })

    await page.context().setOffline(true)
    await typeAtEnd(page, firstEditor, "First tab. ")
    await expect(secondEditor).toContainText("First tab.")
    await typeAtEnd(second, secondEditor, "Second tab. ")
    await expect(firstEditor).toContainText("First tab. Second tab.")

    await page.close()
    await second.context().setOffline(false)
    await expect
      .poll(
        async () => {
          const response = await second.request.get(`/api/workspaces/${workspaceId}/docs/${docId}`)
          if (!response.ok()) return ""
          const { sections } = (await response.json()) as { sections: { markdown: string }[] }
          return sections.map((section) => section.markdown).join("\n")
        },
        { timeout: 20000, message: "the server should hold both tabs' edits, each once" }
      )
      .toBe("First tab. Second tab. ")
  })

  test("should reopen a doc offline with its offline edits and send them once back online", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "doc-reopen")
    const workspaceId = workspaceIdFromUrl(page)
    const channelId = await createChannelViaApi(page, workspaceId, `reopen-docs-${testId}`, "private")
    const docId = await createDocViaApi(page, workspaceId, channelId)
    const editor = docEditor(page, docId)
    const closePane = async () => {
      await pane(page, docId).getByRole("button", { name: "Close", exact: true }).click()
      await expect(pane(page, docId)).toHaveCount(0)
    }

    await openChannel(page, workspaceId, channelId)
    await anchorRow(page, docId).click()
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await typeAtEnd(page, editor, "Saved online. ")

    await page.context().setOffline(true)
    await typeAtEnd(page, editor, "Typed offline")
    await closePane()
    await anchorRow(page, docId).click()
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
    await expect(editor).toContainText("Saved online. Typed offline")
    await typeAtEnd(page, editor, " and after reopening.")
    await closePane()

    await page.context().setOffline(false)
    await expect
      .poll(
        async () => {
          const response = await page.request.get(`/api/workspaces/${workspaceId}/docs/${docId}`)
          if (!response.ok()) return ""
          const { sections } = (await response.json()) as { sections: { markdown: string }[] }
          return sections.map((section) => section.markdown).join("\n")
        },
        { timeout: 20000, message: "the server should hold every edit made offline" }
      )
      .toContain("Saved online. Typed offline and after reopening.")
  })

  test.describe("phone", () => {
    test.use({ hasTouch: true })

    test("should open the doc full-screen from the anchor row and go back to the channel", async ({ page }) => {
      const { testId } = await loginAndCreateWorkspace(page, "doc-phone")
      const workspaceId = workspaceIdFromUrl(page)
      const channelId = await createChannelViaApi(page, workspaceId, `phone-docs-${testId}`, "public")
      const docId = await createDocViaApi(page, workspaceId, channelId)
      await page.setViewportSize({ width: 390, height: 780 })
      await openChannel(page, workspaceId, channelId)

      await anchorRow(page, docId).tap()
      const docPane = pane(page, docId)
      await expect(docEditor(page, docId)).toHaveAttribute("contenteditable", "true", { timeout: 15000 })
      await expect.poll(async () => (await docPane.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(380)
      const box = (await docPane.boundingBox())!
      expect(box.x).toBeLessThanOrEqual(5)

      await docPane.locator("header").first().getByRole("button", { name: "Back" }).tap()
      await expect(docPane).toHaveCount(0)
      await expect.poll(() => new URL(page.url()).searchParams.get("panel")).toBeNull()
      const channelBox = (await pane(page, channelId).boundingBox())!
      expect({ x: Math.round(channelBox.x), width: Math.round(channelBox.width) }).toEqual({ x: 0, width: 390 })
    })
  })
})
