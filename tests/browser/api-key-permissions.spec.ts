import { test, expect, type Page } from "@playwright/test"
import { loginAndCreateWorkspace } from "./helpers"

/**
 * In the open key dialog: the distinct left and right edges of every level
 * control, the distinct right edges of the row chevrons, and any segment or
 * area label cut short.
 */
async function columns(page: Page) {
  // A chevron mid-rotation has a wider box than at rest.
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"))
  return page.getByRole("dialog").evaluate((dialog) => {
    // Half-pixel layout rounds either way, so only a spread past a pixel is a second edge.
    const spread = (xs: number[]) =>
      Math.max(...xs) - Math.min(...xs) > 1 ? [...new Set(xs.map((x) => Math.round(x)))] : [Math.round(xs[0])]
    const levels = [...dialog.querySelectorAll<HTMLElement>("[role=radiogroup]")].filter((group) =>
      group.querySelector("[role=radio]")?.textContent?.match(/^None$/)
    )
    const rects = levels.map((group) => group.getBoundingClientRect())
    const chevrons = [...dialog.querySelectorAll("svg.lucide-chevron-right")].map((svg) => svg.getBoundingClientRect())
    return {
      levelControls: levels.length,
      lefts: spread(rects.map((rect) => rect.left)),
      rights: spread(rects.map((rect) => rect.right)),
      chevrons: spread(chevrons.map((rect) => rect.right)),
      overflowing: [...dialog.querySelectorAll<HTMLElement>("[role=radio], button[aria-expanded] > span.truncate")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent),
    }
  })
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 720 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`key permissions line up and keep the name and actions in view on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await loginAndCreateWorkspace(page, `key-perms-${viewport.name}`)
    const workspaceId = page.url().match(/\/w\/(ws_[^/?]+)/)![1]
    await page.goto(`/w/${workspaceId}?settings=developer`)
    await page.getByRole("button", { name: "New key" }).first().click()
    const dialog = page.getByRole("dialog", { name: "New API key" })
    await expect(dialog).toBeVisible()
    const presets = await dialog
      .getByRole("radio", { name: /Read only|Connected bot|Full access/ })
      .evaluateAll((chips) => new Set(chips.map((chip) => Math.round(chip.getBoundingClientRect().top))).size)
    expect(presets).toBe(1)

    // Three group headers plus eleven areas.
    const aligned = {
      levelControls: 14,
      lefts: [expect.any(Number)],
      rights: [expect.any(Number)],
      chevrons: [expect.any(Number)],
      overflowing: [],
    }
    expect(await columns(page)).toEqual(aligned)

    await dialog.getByRole("button", { name: "Messages" }).click()
    await expect(dialog.getByRole("checkbox", { name: /Write messages/ })).toBeVisible()
    expect(await columns(page)).toEqual(aligned)

    const messages = dialog.getByRole("radiogroup", { name: "Messages" })
    await messages.getByRole("radio", { name: "None" }).focus()
    // Radix moves focus a task after keydown and selects only while the arrow is still held, as it is in a real keypress.
    await page.keyboard.down("ArrowRight")
    await expect(messages.getByRole("radio", { name: "Read" })).toBeFocused()
    await page.keyboard.up("ArrowRight")
    await expect(messages.getByRole("radio", { name: "Read" })).toHaveAttribute("aria-checked", "true")
    await expect(dialog.getByText("1 of 19 permissions")).toBeVisible()

    await dialog.getByRole("radio", { name: "Full access" }).click()
    await expect(dialog.getByText("19 of 19 permissions")).toBeVisible()
    await dialog.getByRole("radiogroup", { name: "Invocations" }).scrollIntoViewIfNeeded()
    await expect(dialog.getByRole("radiogroup", { name: "Invocations" })).toBeInViewport()
    await expect(dialog.getByLabel("Name")).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Create key" })).toBeInViewport()

    await dialog.getByLabel("Name").fill("Release bot")
    await dialog.getByRole("button", { name: "Create key" }).click()
    await expect(page.getByText("New key: Release bot")).toBeVisible()
    await page.getByRole("button", { name: "Actions for Release bot" }).click()
    await page.getByRole("menuitem", { name: "Edit permissions" }).click()
    const edit = page.getByRole("dialog", { name: "Edit permissions" })
    await expect(edit.getByRole("radio", { name: "Full access" })).toHaveAttribute("aria-checked", "true")
    await expect(edit.getByRole("button", { name: "Save permissions" })).toBeInViewport()
  })
}
