import { test, expect } from "@playwright/test"
import { expectApiOk, loginAndCreateWorkspace, openPhoneSidebar, pane, workspaceIdFromUrl } from "./helpers"

for (const touch of [false, true]) {
  test.describe(touch ? "doc creation on phone" : "doc creation on desktop", () => {
    test.use(
      touch
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "dark" }
        : { viewport: { width: 1280, height: 800 }, colorScheme: "light" }
    )

    test("should create standalone docs from the sidebar and Docs header", async ({ page }, testInfo) => {
      await loginAndCreateWorkspace(page, "doc-create-actions")
      const workspaceId = workspaceIdFromUrl(page)
      const activate = async (locator: ReturnType<typeof page.getByRole>) => {
        if (touch) await locator.tap()
        else await locator.click()
      }

      if (touch) await openPhoneSidebar(page)
      await activate(page.getByRole("button", { name: "New", exact: true }))
      const newDoc = page.getByRole(touch ? "button" : "menuitem", { name: "New Doc", exact: true })
      await expect(newDoc).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath("create-menu.png"), animations: "disabled" })

      const sidebarCreated = page.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/streams")
      )
      await activate(newDoc)
      const sidebarResponse = await sidebarCreated
      await expectApiOk(sidebarResponse, "Create doc from sidebar")
      const { stream: sidebarDoc } = await sidebarResponse.json()
      expect(sidebarDoc).toMatchObject({ type: "doc", parentStreamId: null, visibility: "private" })
      await expect(pane(page, sidebarDoc.id).locator(".ProseMirror")).toHaveAttribute("contenteditable", "true")
      await expect(newDoc).toHaveCount(0)
      if (touch) {
        await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveCount(0)
      }

      await page.goto(`/w/${workspaceId}/docs`)
      await expect(page.getByRole("link", { name: /^Untitled/ }).first()).toBeVisible()
      const headerCreate = page.getByRole("button", { name: "New doc", exact: true })
      await expect(headerCreate).toBeEnabled()
      if (touch) {
        const bounds = await headerCreate.boundingBox()
        expect(bounds?.width).toBeGreaterThanOrEqual(44)
        expect(bounds?.height).toBeGreaterThanOrEqual(44)
      }
      await page.screenshot({ path: testInfo.outputPath("docs-header.png"), animations: "disabled" })
      const headerCreated = page.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/streams")
      )
      await activate(headerCreate)
      const headerResponse = await headerCreated
      await expectApiOk(headerResponse, "Create doc from Docs header")
      const { stream: headerDoc } = await headerResponse.json()
      expect(headerDoc).toMatchObject({ type: "doc", parentStreamId: null, visibility: "private" })
      expect(headerDoc.id).not.toBe(sidebarDoc.id)
      await expect(pane(page, headerDoc.id).locator(".ProseMirror")).toHaveAttribute("contenteditable", "true")
    })
  })
}
