import { test, expect, type Page, type Locator } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, createChannel, expectApiOk } from "./helpers"

/**
 * Inbox sidebar section (step 1.3 of the Inbox feature): a stream with an
 * unread message from another user surfaces in the Inbox; opening it clears
 * the server unread count, but the row stays in the Inbox, dimmed ("held"),
 * until explicitly cleared; clearing removes it from the Inbox and it
 * reappears in its home section (Channels).
 */

test.describe.configure({ timeout: 120_000 })

const PHONE = { width: 390, height: 780 }

function extractIds(page: Page): { workspaceId: string; streamId: string } {
  const url = page.url()
  const workspaceMatch = url.match(/\/w\/([^/]+)/)
  const streamMatch = url.match(/\/s\/([^/?]+)/)
  if (!workspaceMatch || !streamMatch) throw new Error(`Could not extract IDs from URL: ${url}`)
  return { workspaceId: workspaceMatch[1], streamId: streamMatch[1] }
}

/**
 * `loginAndCreateWorkspace` pins the type-based All preset (Channels /
 * Scratchpads / DMs) without the Inbox — `{ kind: "unread" }` is an opt-in
 * section (see `packages/types/src/sidebar.ts`), not part of that default.
 * Add it alongside the three type sections and reload so the sidebar
 * repaints from it. Body mirrors `setAllSidebarPreset` in helpers.ts plus the
 * Inbox section; the backend Zod schema rejects drift loudly.
 */
async function enableInboxSection(page: Page, workspaceId: string): Promise<void> {
  const response = await page.request.patch(`/api/workspaces/${workspaceId}/sidebar-config`, {
    data: {
      basePreset: "all",
      sections: [
        { id: "scratchpads", spec: { kind: "type", streamType: "scratchpad" } },
        { id: "channels", spec: { kind: "type", streamType: "channel" } },
        { id: "dms", spec: { kind: "type", streamType: "dm" } },
        { id: "unread", spec: { kind: "unread" } },
      ],
    },
  })
  await expectApiOk(response, "Enable Inbox sidebar section")
  await page.reload()
}

async function serverUnreadCount(page: Page, workspaceId: string, streamId: string): Promise<number> {
  const res = await page.request.get(`/api/workspaces/${workspaceId}/bootstrap`)
  await expectApiOk(res, "Workspace bootstrap")
  const body = (await res.json()) as { data?: { unreadCounts?: Record<string, number> } }
  const counts = body.data?.unreadCounts
  if (!counts) throw new Error(`Bootstrap response missing unreadCounts; keys: ${Object.keys(body).join(",")}`)
  return counts[streamId] ?? 0
}

/** Each `StreamSection` (Inbox, Channels, ...) renders as its own `div.mb-4`
 *  wrapping an `h3` header — scope a row lookup to the section whose header
 *  reads `heading`. */
function sectionByHeading(page: Page, heading: string): Locator {
  return page.locator("div.mb-4", { has: page.getByRole("heading", { name: heading, level: 3 }) })
}

/** `InboxRowClearButton` renders as a DOM sibling of the row's `<Link>`, not
 *  nested inside it — both share the `.reveal-host` container, so a row
 *  lookup keys off that container rather than the link itself. */
function sidebarRow(section: Locator, streamId: string): Locator {
  return section.locator(`.reveal-host:has(a[href*="/s/${streamId}"])`)
}

/** A held Inbox row dims via `opacity-60` on the avatar+text container. */
async function isDimmed(row: Locator): Promise<boolean> {
  return (await row.locator(".opacity-60").count()) > 0
}

async function seedUnreadChannel(page: Page, browser: import("@playwright/test").Browser, prefix: string) {
  const owner = await loginAndCreateWorkspace(page, prefix)
  const testId = owner.testId
  const workspaceIdFromCreate = page.url().match(/\/w\/([^/?]+)/)![1]
  await enableInboxSection(page, workspaceIdFromCreate)

  await createChannel(page, `${prefix}-${testId}`)
  const { workspaceId, streamId } = extractIds(page)

  // Navigate away before the second user posts, so the unread is real
  // server-side rather than optimistically-not-counted while open.
  await page.goto(`/w/${workspaceId}`)

  const other = await loginInNewContext(browser, `${prefix}-b-${testId}@example.com`, `${prefix} B ${testId}`)
  await expectApiOk(
    await other.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: `${prefix} B ${testId}` },
    }),
    "Second user joins workspace"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`, { data: {} }),
    "Second user joins the channel"
  )
  await expectApiOk(
    await other.page.request.post(`/api/workspaces/${workspaceId}/messages`, {
      data: { streamId, content: `[${testId}] unread hello` },
    }),
    "Second user posts an unread message"
  )

  await expect
    .poll(() => serverUnreadCount(page, workspaceId, streamId), {
      timeout: 10000,
      message: "server should report the seeded unread",
    })
    .toBeGreaterThan(0)

  return { testId, workspaceId, streamId, otherContext: other.context }
}

test.describe("Inbox sidebar section", () => {
  test("a held row clears from the Inbox on click and returns to its home section", async ({ page, browser }) => {
    const { workspaceId, streamId, otherContext } = await seedUnreadChannel(page, browser, "inbox")

    // The unread channel surfaces in the Inbox, undimmed (it's unread, not held).
    const inboxRow = sidebarRow(sectionByHeading(page, "Inbox"), streamId)
    await expect(inboxRow).toBeVisible({ timeout: 10000 })
    expect(await isDimmed(inboxRow)).toBe(false)

    // Opening it auto-reads (a single short message fits on screen, no scroll
    // needed) — the server count reaches 0, but the row stays in the Inbox,
    // now dimmed ("held") instead of disappearing.
    await inboxRow.locator("a").click()
    await expect(page).toHaveURL(new RegExp(`/s/${streamId}`))
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "auto-read should clear the server unread count",
      })
      .toBe(0)
    await expect(inboxRow).toBeVisible({ timeout: 10000 })
    await expect.poll(() => isDimmed(inboxRow), { timeout: 10000 }).toBe(true)

    // Inbox membership trumps every other section while it holds — the
    // stream does not also show under Channels.
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toHaveCount(0)

    // Clearing it (row hover reveals the Clear button) removes it from the
    // Inbox and it reappears in Channels; with nothing else held/unread, the
    // Inbox goes back to "All caught up".
    await inboxRow.hover()
    await inboxRow.getByRole("button", { name: "Clear from Inbox" }).click()
    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)
    await expect(sectionByHeading(page, "Inbox").getByText("All caught up")).toBeVisible({ timeout: 10000 })
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })

    // The clear is server-authoritative (`stream_read_state.inbox_held`), not
    // just an optimistic local unhold — a fresh bootstrap load must agree.
    await page.reload()
    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })

    await otherContext.close()
  })

  test("the E key clears the open stream from the Inbox, and it stays cleared after a reload", async ({
    page,
    browser,
  }) => {
    const { workspaceId, streamId, otherContext } = await seedUnreadChannel(page, browser, "inbox-ekey")

    const inboxRow = sidebarRow(sectionByHeading(page, "Inbox"), streamId)
    await expect(inboxRow).toBeVisible({ timeout: 10000 })

    // Open it: auto-read holds it in the Inbox (dimmed) instead of dropping it.
    await inboxRow.locator("a").click()
    await expect(page).toHaveURL(new RegExp(`/s/${streamId}`))
    await expect
      .poll(() => serverUnreadCount(page, workspaceId, streamId), {
        timeout: 15000,
        message: "auto-read should clear the server unread count",
      })
      .toBe(0)
    await expect.poll(() => isDimmed(inboxRow), { timeout: 10000 }).toBe(true)

    // "E" with nothing hovered falls back to the open stream, since it's the
    // one held in the Inbox (`resolveClearInboxTargetStreamId`).
    await page.mouse.move(0, 0)
    await page.keyboard.press("e")

    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })

    // Same server-authoritative guarantee as the click-to-clear path above.
    await page.reload()
    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })

    await otherContext.close()
  })

  test("phone: a held row clears via the long-press action drawer", async ({ page: setupPage, browser }) => {
    const { workspaceId, streamId, otherContext } = await seedUnreadChannel(setupPage, browser, "inbox-phone")

    // Read it from the setup page first, so the mobile context starts on the
    // stream's own URL (not the bare workspace root, which renders the phone
    // sidebar off-canvas with nothing to toggle) and the row is a realistic
    // "held" Inbox row for the drawer Clear action to act on.
    await setupPage.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect
      .poll(() => serverUnreadCount(setupPage, workspaceId, streamId), { timeout: 15000 })
      .toBe(0)

    const storageState = await setupPage.context().storageState()
    const context = await browser.newContext({ storageState, hasTouch: true, viewport: PHONE })
    const page = await context.newPage()
    await page.goto(setupPage.url())

    // Reveal the (off-canvas on phone) sidebar. Mirrors sidebar-menu-dismissal.spec.ts:
    // the on-screen "Pin sidebar" toggle opens it as an overlay.
    const toggles = page.getByRole("button", { name: "Pin sidebar" })
    await expect(toggles.first()).toBeAttached({ timeout: 20000 })
    let opened = false
    for (let i = 0; i < (await toggles.count()); i += 1) {
      const box = await toggles.nth(i).boundingBox()
      if (box && box.x >= 0 && box.x + box.width <= PHONE.width) {
        await toggles.nth(i).click()
        opened = true
        break
      }
    }
    expect(opened, "expected an on-screen sidebar toggle on the phone viewport").toBe(true)

    const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
    await expect(nav.getByRole("button", { name: "Collapse sidebar" })).toBeVisible({ timeout: 15000 })

    const inboxRow = sidebarRow(sectionByHeading(page, "Inbox"), streamId)
    await expect(inboxRow).toBeVisible({ timeout: 10000 })

    // Long-press: `onLongPress` fires 500ms after touchstart regardless of
    // touchend (`useSidebarItemDrawer` doesn't set `triggerOnTouchEnd`), so
    // the drawer is open before the touch is released. Once it's open, the
    // background sidebar (including this row) is correctly `aria-hidden` for
    // screen readers, which makes the row's `getByRole`-composed locator stop
    // matching anything — grab an ElementHandle up front so the touchend
    // dispatch targets the same node without re-resolving that locator.
    const link = inboxRow.locator("a")
    const box = (await link.boundingBox())!
    const linkHandle = (await link.elementHandle())!
    const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
    await linkHandle.dispatchEvent("touchstart", { touches: [touch], changedTouches: [touch], targetTouches: [touch] })
    await page.waitForTimeout(700)
    await linkHandle.dispatchEvent("touchend", { touches: [], changedTouches: [], targetTouches: [] })

    const drawer = page.locator("[data-vaul-drawer]")
    await expect(drawer).toBeVisible({ timeout: 10000 })
    await drawer.getByRole("button", { name: "Clear", exact: true }).click()

    await expect(sidebarRow(sectionByHeading(page, "Inbox"), streamId)).toHaveCount(0)
    await expect(sidebarRow(sectionByHeading(page, "Channels"), streamId)).toBeVisible({ timeout: 10000 })

    await context.close()
    await otherContext.close()
  })
})
