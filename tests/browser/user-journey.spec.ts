import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace, generateTestId, waitForWorkspaceProvisioned } from "./helpers"

/**
 * Full user journey E2E test.
 *
 * Tests the complete flow:
 * 1. New user logs in via stub auth
 * 2. Creates a workspace
 * 3. Creates a channel
 * 4. Sends a message
 */

test.describe("User Journey", () => {
  test("should allow new user to sign in, create workspace, create channel, and send message", async ({ page }) => {
    // Generate unique identifiers for this test run
    const testId = generateTestId()
    const testEmail = `e2e-${testId}@example.com`
    const testName = `E2E User ${testId}`
    const workspaceName = `E2E Workspace ${testId}`
    const channelName = `test-${testId}`

    // Step 1: Navigate to login page
    await page.goto("/login")
    await expect(page.getByRole("heading", { name: "Threa" })).toBeVisible()

    // Step 2: Click sign in - should redirect to stub auth page
    await page.getByRole("button", { name: "Sign in with WorkOS" }).click()

    // Step 3: Should be on the fake login page
    await expect(page.getByRole("heading", { name: "Test Login" })).toBeVisible()
    await expect(page.getByText("Stub auth enabled")).toBeVisible()

    // Step 4: Fill in custom credentials and submit
    await page.getByLabel("Email").fill(testEmail)
    await page.getByLabel("Name").fill(testName)
    await page.getByRole("button", { name: "Sign In" }).click()

    // Step 5: Should land on workspace selection (new user has no workspaces)
    await expect(page.getByRole("heading", { name: `Welcome, ${testName}` })).toBeVisible()
    await expect(page.getByPlaceholder("New workspace name")).toBeVisible()

    // Step 6: Create a workspace
    await page.getByPlaceholder("New workspace name").fill(workspaceName)
    await page.getByRole("button", { name: "Create Workspace" }).click()
    await page.waitForURL(/\/w\/[^/]+/, { timeout: 10000 })

    const workspaceMatch = page.url().match(/\/w\/([^/?]+)/)
    expect(workspaceMatch).toBeTruthy()
    const workspaceId = workspaceMatch![1]
    await waitForWorkspaceProvisioned(page, workspaceId)
    await page.goto(`/w/${workspaceId}`)

    // Step 7: Should enter the workspace - verify sidebar is visible (empty state shows buttons)
    await expect(page.getByRole("button", { name: "+ New Scratchpad" })).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("button", { name: "+ New Channel" })).toBeVisible({ timeout: 10000 })

    // Step 8: Create a channel via the modal dialog
    await page.getByRole("button", { name: "+ New Channel" }).click()
    await page.getByRole("dialog").getByPlaceholder("channel-name").fill(channelName)
    const createChannelButton = page.getByRole("dialog").getByRole("button", { name: "Create Channel" })
    await expect(createChannelButton).toBeEnabled({ timeout: 5000 })
    await createChannelButton.click()

    // Step 9: Verify we're in the channel view (channel heading and empty state)
    await expect(page.getByRole("heading", { name: `#${channelName}`, level: 1 })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText("No messages yet")).toBeVisible()

    // Step 11: Send a message (rich text editor uses contenteditable, not input)
    const messageContent = `Hello from E2E test! ${testId}`
    await page.locator("[contenteditable='true']").click()
    await page.keyboard.type(messageContent)

    // Step 12: Click Send button
    await page.getByRole("button", { name: "Send" }).click()

    // Step 13: Verify message appears
    await expect(page.getByRole("main").getByText(messageContent)).toBeVisible({ timeout: 5000 })
  })

  test("should authenticate new user and show welcome page", async ({ page }) => {
    const testId = generateTestId()
    const testEmail = `preset-${testId}@example.com`
    const testName = `Preset User ${testId}`

    await page.goto("/login")
    await page.getByRole("button", { name: "Sign in with WorkOS" }).click()

    // Fill in custom credentials
    await page.getByLabel("Email").fill(testEmail)
    await page.getByLabel("Name").fill(testName)
    await page.getByRole("button", { name: "Sign In" }).click()

    // Should be redirected and logged in — new user sees welcome page
    await expect(page.getByRole("heading", { name: `Welcome, ${testName}` })).toBeVisible()
  })

  test("should create and navigate to new scratchpad", async ({ page }) => {
    await loginAndCreateWorkspace(page, "nav")

    // Now in workspace - create a scratchpad
    await page.getByRole("button", { name: "+ New Scratchpad" }).click()

    // Should navigate to the scratchpad
    await expect(page.getByText(/Type a message|No messages yet/)).toBeVisible({ timeout: 5000 })
  })

  test("should navigate to channel when using quick switcher search", async ({ page }) => {
    const { testId } = await loginAndCreateWorkspace(page, "quickswitch")

    // Create a channel with a unique name we can search for
    const quickSwitchChannel = `qs-test-${testId}`
    await page.getByRole("button", { name: "+ New Channel" }).click()
    await page.getByRole("dialog").getByPlaceholder("channel-name").fill(quickSwitchChannel)
    const createChannelButton = page.getByRole("dialog").getByRole("button", { name: "Create Channel" })
    await expect(createChannelButton).toBeEnabled({ timeout: 5000 })
    await createChannelButton.click()

    // Creating a channel navigates to it - verify via main content heading
    await expect(page.getByRole("heading", { name: `#${quickSwitchChannel}`, level: 1 })).toBeVisible({ timeout: 5000 })

    // Navigate away from the channel via the Drafts quick link. Drafts is a
    // list page with no autofocused composer, so the Cmd+K quick-switcher opens
    // cleanly (a focused message editor can otherwise swallow the shortcut).
    await page.getByRole("link", { name: "Drafts" }).click()
    await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible({ timeout: 5000 })

    // Now test the quick switcher - open with Cmd+K (Meta+K on Mac)
    await page.keyboard.press("Meta+k")

    // Quick switcher dialog should appear - look for the mode tabs as indicator
    await expect(page.getByRole("tab", { name: "Stream search" })).toBeVisible({ timeout: 2000 })

    // Type the channel name to search (focus should already be in the input)
    await page.keyboard.type(quickSwitchChannel)

    const quickSwitcherResult = page.getByRole("option", { name: new RegExp(`#${quickSwitchChannel}`) }).first()
    await expect(quickSwitcherResult).toBeVisible({ timeout: 5000 })
    await quickSwitcherResult.click()

    // Should navigate to the channel (quick switcher closes)
    await expect(page.getByRole("tab", { name: "Stream search" })).not.toBeVisible({ timeout: 2000 })

    // Verify we're back in the channel via the main heading
    await expect(page.getByRole("heading", { name: `#${quickSwitchChannel}`, level: 1 })).toBeVisible({
      timeout: 10000,
    })
  })
})
