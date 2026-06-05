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
    await page
      .getByRole("button", { name: /^Unlock$/ })
      .first()
      .click()
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

  test("an attached image round-trips: encrypt on send, decrypt-and-render on view", async ({ page }) => {
    await loginAndCreateWorkspace(page, "e2e-enc-attach")

    // Create an encrypted scratchpad and stay unlocked (device trust is
    // irrelevant here — we send within the same session).
    await page.getByRole("button", { name: "New", exact: true }).click()
    await page.getByRole("menuitem", { name: /New Encrypted Scratchpad/i }).click()
    const setup = page.getByRole("dialog")
    await expect(setup.getByText("Set up encrypted scratchpads")).toBeVisible({ timeout: 10_000 })
    await setup.locator("#e2e-passphrase").fill(PASSPHRASE)
    await setup.locator("#e2e-passphrase-confirm").fill(PASSPHRASE)
    await setup.locator("#e2e-acknowledged").check()
    // Interacting with the trust-device checkbox just above the button settles
    // the dialog's scroll so the action button is reachable (same sequence the
    // gate/rename tests use).
    const trustDevice = setup.locator("#e2e-setup-trust-device")
    if (await trustDevice.isChecked()) await trustDevice.uncheck()
    await setup.getByRole("button", { name: "Enable encryption" }).click()
    await expect(page.getByText("Encrypted", { exact: true })).toBeVisible({ timeout: 15_000 })

    // Paste a 1x1 PNG into the composer → it's encrypted client-side and the
    // ciphertext uploaded; the chip confirms the upload completed.
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    await page.evaluate(() => {
      const el = document.querySelector("[contenteditable='true']")
      if (!el) throw new Error("Editor not found")
      // 1x1 red PNG.
      const png = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00,
        0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ])
      // The editor's paste handler renames pasted images to sequential
      // pasted-image-N.png (rich-editor.tsx), so the source name here is
      // intentionally different from the alt text asserted below.
      const file = new File([png], "screenshot.png", { type: "image/png" })
      const dt = new DataTransfer()
      dt.items.add(file)
      el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }))
    })
    await expect(editor.locator("span[data-type='attachment-reference']")).toBeVisible({ timeout: 15_000 })

    // Send via the composer's Send button (deterministic — pressing Enter races
    // with the caret position after the async paste insertion). The composer
    // clears its attachment reference once the send fires, which we assert first
    // so a slow decrypt-render below can't be confused with a send that never
    // happened.
    await page.getByRole("button", { name: "Send", exact: true }).first().click()
    await expect(editor.locator("span[data-type='attachment-reference']")).toHaveCount(0, { timeout: 15_000 })

    // The sender's own row must render the image from a *decrypted blob* — not
    // the server's opaque ciphertext. The `<img>` element only mounts once the
    // ciphertext has been fetched and decrypted into an object URL, so its mere
    // presence (with a `blob:` src) proves the local decrypt round-trip. Cold
    // first paint walks the full pipeline (echo → seed → S3 GET → AES-GCM open),
    // so allow generous headroom.
    const image = page.locator('img[alt="pasted-image-1.png"]')
    await expect(image).toBeVisible({ timeout: 30_000 })
    expect(await image.getAttribute("src")).toMatch(/^blob:/)
  })

  test("in-stream search matches the DECRYPTED body of an unlocked encrypted message (E2EE-15)", async ({ page }) => {
    await loginAndCreateWorkspace(page, "e2e-enc-search")

    // Create an encrypted scratchpad and stay unlocked (we search within the
    // same session, so the body is decryptable on demand).
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

    // Send a message. On the wire this is sealed — the server stores ciphertext
    // plus a zero-width placeholder, never this token — so any later search hit
    // can ONLY come from decrypting locally. That's the documented promise the
    // old code broke (Cmd-F returned zero matches because both phases saw the
    // placeholder): E2EE-15 / UX-21.
    const token = "VELVET-OTTER-SEARCHME"
    const editor = page.locator("[contenteditable='true']")
    await editor.click()
    await page.keyboard.type(`the launch codename is ${token}`)
    await page.getByRole("button", { name: "Send", exact: true }).first().click()
    // The row renders decrypted in the timeline (composer clears on send).
    await expect(page.getByText(token).first()).toBeVisible({ timeout: 20_000 })

    // Open in-stream search via the same DOM event the header search button
    // dispatches — deterministic across Cmd/Ctrl platforms — and query the token
    // in lowercase to also prove the match is case-insensitive.
    await page.evaluate(() => document.dispatchEvent(new Event("threa:open-stream-search")))
    const searchInput = page.getByPlaceholder("Search in conversation...")
    await expect(searchInput).toBeVisible({ timeout: 10_000 })
    await searchInput.fill(token.toLowerCase())

    // The match counter (activeMatchIndex+1 / matchCount) only renders once the
    // local decrypted search found the body. One message, one occurrence → 1/1.
    await expect(page.getByText("1/1")).toBeVisible({ timeout: 10_000 })
  })
})
