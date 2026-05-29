import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, createChannel } from "./helpers"

/**
 * Tests that the sidebar preview mode works like Notion's sidebar:
 * hovering near the left edge shows a preview, clicking inside it
 * does NOT pin it open, and moving the mouse away collapses it.
 *
 * Pinning only happens via the explicit "Pin sidebar" topbar button.
 */

test.describe("Sidebar Preview Behavior", () => {
  /** Hover near the left edge to trigger sidebar preview from collapsed state */
  async function hoverToPreview(page: import("@playwright/test").Page) {
    const viewport = page.viewportSize()!
    await page.mouse.move(15, viewport.height / 2)
  }

  /** Move mouse to center of viewport (away from sidebar) */
  async function moveAwayFromSidebar(page: import("@playwright/test").Page) {
    const viewport = page.viewportSize()!
    await page.mouse.move(viewport.width / 2, viewport.height / 2)
  }

  test("should not pin sidebar when clicking a channel in preview mode", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "sidebar-preview")

    const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })

    // Set up: create a channel while sidebar is pinned
    const channelName = `preview-test-${testId}`
    await createChannel(page, channelName)

    // Navigate away (to Drafts) so the channel link becomes a navigation
    // target in the sidebar rather than the currently-open view. The big
    // "+ New Scratchpad" button only exists in the empty state, so use the
    // always-present Drafts quick link instead.
    await page.getByRole("link", { name: "Drafts" }).click()
    await expect(page).toHaveURL(/\/drafts/, { timeout: 5000 })

    // Collapse the sidebar via topbar, then move the mouse away: the redesign's
    // hover-preview re-expands the sidebar while the pointer sits near the
    // left-edge toggle, so the collapsed 6px state is only observable once the
    // pointer leaves the magnetic zone.
    await page.getByRole("button", { name: "Collapse sidebar" }).click()
    await moveAwayFromSidebar(page)
    await expect(sidebar).toHaveCSS("width", "6px", { timeout: 3000 })

    // Hover near left edge to trigger preview
    await hoverToPreview(page)
    await expect(sidebar).not.toHaveCSS("width", "6px", { timeout: 3000 })

    // Click the channel link inside the previewed sidebar
    await page.getByRole("link", { name: `#${channelName}` }).click()

    // Sidebar should still be visible (mouse is over it)
    await expect(sidebar).not.toHaveCSS("width", "6px")

    // Move mouse away from sidebar
    await moveAwayFromSidebar(page)

    // Sidebar should collapse (proves it was preview, not pinned)
    await expect(sidebar).toHaveCSS("width", "6px", { timeout: 3000 })
  })

  test("topbar pin button should still pin the sidebar", async ({ page }) => {
    await loginAndCreateWorkspace(page, "sidebar-pin")

    const sidebar = page.getByRole("navigation", { name: "Sidebar navigation" })

    // Sidebar starts pinned
    await expect(sidebar).not.toHaveCSS("width", "6px")

    // Collapse via topbar, then move the mouse away so the hover-preview
    // doesn't keep the sidebar expanded while the pointer rests on the toggle.
    await page.getByRole("button", { name: "Collapse sidebar" }).click()
    await moveAwayFromSidebar(page)
    await expect(sidebar).toHaveCSS("width", "6px", { timeout: 3000 })

    // Pin from collapsed: hover the left edge to reveal the preview, then click
    // the Pin toggle inside the revealed sidebar header. (The page-topbar copy
    // sits under the preview's 30px "coyote-time" hover zone, which intercepts
    // the click — and moving the pointer toward it is what opens the preview in
    // the first place. Scope to the sidebar nav: the page topbar renders its own
    // "Pin sidebar" copy too.)
    await hoverToPreview(page)
    await expect(sidebar).not.toHaveCSS("width", "6px", { timeout: 3000 })
    await sidebar.getByRole("button", { name: "Pin sidebar" }).click()

    // Move mouse away - sidebar should stay open because it's pinned (a mere
    // preview would collapse back to 6px once the pointer leaves).
    await moveAwayFromSidebar(page)
    await expect(sidebar).not.toHaveCSS("width", "6px")
  })
})
