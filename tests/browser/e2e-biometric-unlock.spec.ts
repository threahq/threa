import { test, expect } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * Biometric (WebAuthn PRF) device unlock, end-to-end against a CDP virtual
 * authenticator (WebAuthn is unavailable in jsdom, so this is the only place the
 * register→wrap and assert→unwrap ceremony is exercised). A probe confirmed this
 * Chrome's virtual authenticator supports PRF.
 */

const PASSPHRASE = "correct horse battery staple"

test.describe("E2E biometric unlock", () => {
  test("set up with biometric, then unlock via biometric after reload", async ({ page }) => {
    // A PRF-capable virtual authenticator that auto-satisfies user presence +
    // verification, attached before any WebAuthn call. It lives on the context,
    // so the registered credential survives the reload below.
    const client = await page.context().newCDPSession(page)
    await client.send("WebAuthn.enable")
    await client.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        automaticPresenceSimulation: true,
        isUserVerified: true,
        hasPrf: true,
      },
    })

    await loginAndCreateWorkspace(page, "e2e-bio")

    // Create an encrypted scratchpad → inline setup modal.
    await page.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("menuitem", { name: /New Encrypted Scratchpad/i }).click()
    const setup = page.getByRole("dialog")
    await expect(setup.getByText("Set up encrypted scratchpads")).toBeVisible({ timeout: 10_000 })
    await setup.locator("#e2e-passphrase").fill(PASSPHRASE)
    await setup.locator("#e2e-passphrase-confirm").fill(PASSPHRASE)
    await setup.locator("#e2e-acknowledged").check()

    // Enable biometric (trust-device defaults on, so the option is shown).
    await setup.getByRole("button", { name: /Set up biometric unlock/i }).click()
    await expect(setup.getByText(/Biometric unlock enabled/i)).toBeVisible({ timeout: 10_000 })
    await setup.getByRole("button", { name: "Enable encryption" }).click()

    // Created + unlocked: gate yields, Encrypted pill shows.
    await expect(page.getByText("This scratchpad is encrypted")).toHaveCount(0)
    await expect(page.getByText("Encrypted", { exact: true })).toBeVisible({ timeout: 15_000 })

    // Reload: biometric-gated, so the full-page gate returns.
    await page.reload()
    await expect(page.getByText("This scratchpad is encrypted")).toBeVisible({ timeout: 15_000 })

    // Unlock → provider opens the biometric modal (device is webauthnProtected) →
    // the assertion is auto-verified by the virtual authenticator.
    await page.getByRole("button", { name: /^Unlock$/ }).first().click()
    const bio = page.getByRole("dialog")
    await expect(bio.getByRole("heading", { name: "Unlock with biometrics" })).toBeVisible({ timeout: 10_000 })
    await bio.getByRole("button", { name: /Unlock with biometrics/i }).click()

    await expect(page.getByText("This scratchpad is encrypted")).toHaveCount(0, { timeout: 15_000 })
  })
})
