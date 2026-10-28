import { test, expect } from "@playwright/test"
import {
  anchorRow,
  createChannelViaApi,
  createDocViaApi,
  expectApiOk,
  joinWorkspace,
  loginAndCreateWorkspace,
  openChannel,
  pane,
  renameDoc,
  userIdByEmail,
  workspaceIdFromUrl,
} from "./helpers"

/**
 * A doc's creator moves it from one channel to another from the doc's menu. A move that changes who can read
 * the doc asks first; both hosts' timelines record it, and a reader who lost access loses the doc live.
 */

test.describe.configure({ timeout: 150_000 })

test.describe("Doc move", () => {
  test("should re-host the doc and drop it for readers who lose access when moving it to a private channel", async ({
    browser,
  }) => {
    const ownerContext = await browser.newContext()
    const owner = await ownerContext.newPage()
    const { testId } = await loginAndCreateWorkspace(owner, "doc-move")
    const workspaceId = workspaceIdFromUrl(owner)
    const alphaSlug = `alpha-${testId}`
    const bravoSlug = `bravo-${testId}`
    const alphaId = await createChannelViaApi(owner, workspaceId, alphaSlug, "public")
    const bravoId = await createChannelViaApi(owner, workspaceId, bravoSlug, "private")
    const docId = await createDocViaApi(owner, workspaceId, alphaId)
    const title = `Runbook ${testId}`
    await renameDoc(owner, workspaceId, docId, title)
    const member = await joinWorkspace(browser, workspaceId, "doc-move-member", testId)

    try {
      await expectApiOk(
        await owner.request.post(`/api/workspaces/${workspaceId}/streams/${alphaId}/members`, {
          data: { memberId: await userIdByEmail(owner, workspaceId, member.email) },
        }),
        "Add member to alpha"
      )

      await member.page.goto(`/w/${workspaceId}/docs`)
      const memberDocRow = member.page.getByRole("listitem").getByRole("link", { name: new RegExp(title) })
      await expect(memberDocRow).toBeVisible({ timeout: 15000 })

      await openChannel(owner, workspaceId, alphaId)
      await expect(pane(owner, alphaId).getByRole("button", { name: "1 doc" })).toBeVisible({ timeout: 15000 })
      await anchorRow(owner, docId).first().click()
      await expect(pane(owner, docId)).toContainText(alphaSlug, { timeout: 15000 })

      await pane(owner, docId).getByRole("button", { name: "Stream actions" }).first().click()
      await owner.getByRole("menuitem", { name: "Move to…" }).click()
      const picker = owner.getByRole("dialog", { name: `Move ${title} to…` })
      await expect(picker).toBeVisible()
      await picker.getByPlaceholder("Search streams…").fill(bravoSlug)
      await picker.getByRole("option", { name: `#${bravoSlug}` }).click()

      const confirm = owner.getByRole("alertdialog", { name: "Change who can read this doc?" })
      await expect(confirm).toContainText("1 person will lose access.")
      const moved = owner.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/move")
      )
      await confirm.getByRole("button", { name: "Move" }).click()
      await expectApiOk(await moved, "Move doc")

      await expect(confirm).toBeHidden()
      await expect(picker).toBeHidden()
      await expect(pane(owner, docId)).toContainText(bravoSlug, { timeout: 15000 })
      await expect(pane(owner, alphaId).getByRole("button", { name: "1 doc" })).toHaveCount(0)
      await expect(pane(owner, alphaId)).toContainText(`moved ${title} to #${bravoSlug}`, { timeout: 15000 })

      await expect(memberDocRow).toHaveCount(0, { timeout: 15000 })

      await openChannel(owner, workspaceId, bravoId)
      await expect(pane(owner, bravoId).getByRole("button", { name: "1 doc" })).toBeVisible({ timeout: 15000 })
      await expect(pane(owner, bravoId)).toContainText(`moved ${title} here from #${alphaSlug}`, { timeout: 15000 })

      await openChannel(member.page, workspaceId, alphaId)
      await expect(pane(member.page, alphaId)).toContainText("moved a doc to another stream", { timeout: 15000 })
    } finally {
      await member.context.close()
      await ownerContext.close()
    }
  })
})
