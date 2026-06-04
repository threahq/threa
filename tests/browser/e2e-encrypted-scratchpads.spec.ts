import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * Browser verification for the E2E-alignment stack's user-facing surfaces that
 * don't need a live enclave (the enclave isn't started under dev:test):
 *
 *  - the full-page unlock GATE replaces the timeline/composer when an encrypted
 *    scratchpad is locked, and yields to the timeline once unlocked;
 *  - the header "Encrypted" pill marks the stream;
 *  - renaming an unlocked encrypted scratchpad persists and displays.
 *
 * Interjection catch-up is exercised by the backend unit + integration suites
 * (it runs a real enclave turn, which dev:test doesn't host).
 */

const PASSPHRASE = "correct horse battery staple"

test.describe("E2E encrypted scratchpads", () => {
  test("unlock gate, Encrypted pill, and encrypted rename", async ({ page }) => {
    await loginAndCreateWorkspace(page, "e2e-enc")

    // Open the sidebar "New" create menu and pick the encrypted scratchpad.
    await page.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("menuitem", { name: /New Encrypted Scratchpad/i }).click()

    // First-time setup: passphrase + confirm + acknowledge. Leave the device
    // UNtrusted so a reload lands locked — that's how we drive the gate.
    const setup = page.getByRole("dialog")
    await expect(setup.getByText("Set up encrypted scratchpads")).toBeVisible({ timeout: 10_000 })
    await setup.locator("#e2e-passphrase").fill(PASSPHRASE)
    await setup.locator("#e2e-passphrase-confirm").fill(PASSPHRASE)
    await setup.locator("#e2e-acknowledged").check()
    const trustDevice = setup.locator("#e2e-setup-trust-device")
    if (await trustDevice.isChecked()) await trustDevice.uncheck()
    await setup.getByRole("button", { name: "Enable encryption" }).click()

    // Created and unlocked: the gate yields to the timeline, and the header shows
    // the "Encrypted" pill. The gate's locked copy must NOT be present.
    await expect(page.getByText("This scratchpad is encrypted")).toHaveCount(0)
    await expect(page.getByText("Encrypted", { exact: true })).toBeVisible({ timeout: 15_000 })

    // Rename while unlocked → the new name shows in the header. Clicking the
    // header title swaps in an Input with the "Scratchpad name" placeholder.
    const newName = "Therapy notes"
    await page.getByRole("heading", { level: 1 }).click()
    const rename = page.getByPlaceholder("Scratchpad name")
    await rename.fill(newName)
    await rename.press("Enter")
    await expect(page.getByRole("heading", { name: newName })).toBeVisible({ timeout: 10_000 })

    // Reload: device wasn't trusted, so the session is locked → the full-page
    // gate replaces the timeline, and the inline Unlock affordance appears.
    await page.reload()
    await expect(page.getByText("This scratchpad is encrypted")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: /^Unlock$/ }).first()).toBeVisible()

    // Unlock from the gate → the gate clears and the timeline returns.
    await page.getByRole("button", { name: /^Unlock$/ }).first().click()
    const unlock = page.getByRole("dialog")
    await expect(unlock.getByText("Unlock encrypted scratchpads")).toBeVisible({ timeout: 10_000 })
    await unlock.locator("input[type='password'], input[type='text']").first().fill(PASSPHRASE)
    await unlock.getByRole("button", { name: /^Unlock$/ }).click()
    await expect(page.getByText("This scratchpad is encrypted")).toHaveCount(0, { timeout: 15_000 })
  })

  test("creating an encrypted scratchpad while locked unlocks inline, then creates", async ({ page }) => {
    await loginAndCreateWorkspace(page, "e2e-enc-locked")

    // First-time setup via the create flow, with device trust OFF so a reload
    // lands locked (key exists, device not trusted) — the `locked` create branch.
    await page.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("menuitem", { name: /New Encrypted Scratchpad/i }).click()
    const setup = page.getByRole("dialog")
    await expect(setup.getByText("Set up encrypted scratchpads")).toBeVisible({ timeout: 10_000 })
    await setup.locator("#e2e-passphrase").fill(PASSPHRASE)
    await setup.locator("#e2e-passphrase-confirm").fill(PASSPHRASE)
    await setup.locator("#e2e-acknowledged").check()
    const trustDevice = setup.locator("#e2e-setup-trust-device")
    if (await trustDevice.isChecked()) await trustDevice.uncheck()
    await setup.getByRole("button", { name: "Enable encryption" }).click()
    await expect(page.getByText("Encrypted", { exact: true })).toBeVisible({ timeout: 15_000 })

    await page.reload()
    await expect(page.getByText("This scratchpad is encrypted")).toBeVisible({ timeout: 15_000 })

    // Now the key exists but the session is locked. Asking for a new encrypted
    // scratchpad should open the unlock modal (not a dead-end), then create it.
    await page.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("menuitem", { name: /New Encrypted Scratchpad/i }).click()
    const unlock = page.getByRole("dialog")
    await expect(unlock.getByText("Unlock encrypted scratchpads")).toBeVisible({ timeout: 10_000 })
    await unlock.locator("input[type='password'], input[type='text']").first().fill(PASSPHRASE)
    await unlock.getByRole("button", { name: /^Unlock$/ }).click()

    // The deferred create runs after unlock → a fresh encrypted scratchpad opens.
    await expect(page.getByText("This scratchpad is encrypted")).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText("Encrypted", { exact: true })).toBeVisible({ timeout: 15_000 })
  })
})
