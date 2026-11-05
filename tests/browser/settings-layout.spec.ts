import { test, expect, type Page, type Request } from "@playwright/test"
import { createChannelViaApi, loginAndCreateWorkspace } from "./helpers"

/**
 * Where the open settings page's title starts, the outer edges of its
 * sections, each card whose row controls don't share one right edge, run past the card's padding, or squeeze a button's label past its
 * padding, where the page's row chevrons end, and where its control text starts.
 */
async function edges(page: Page) {
  return page.getByRole("dialog").evaluate((dialog) => {
    const heading = dialog.querySelector("header h2")!
    const content = heading.closest("header")!.nextElementSibling!
    const sections = [...content.querySelectorAll("section")]
    // Half-pixel layout rounds either way, so only a spread past a pixel is a second edge.
    const spread = (xs: number[]) =>
      xs.length > 0 && Math.max(...xs) - Math.min(...xs) > 1 ? [...new Set(xs.map((x) => Math.round(x)))] : []
    const rects = sections.map((el) => el.getBoundingClientRect())
    const raggedCards = sections.flatMap((section) => {
      const card = section.querySelector(":scope > .border")
      if (!card) return []
      const cardRight = card.getBoundingClientRect().right
      const wrappers = [...card.querySelectorAll<HTMLElement>("[data-setting-control]")].filter(
        (wrapper) => wrapper.getBoundingClientRect().width > 0
      )
      const controls = wrappers.map((wrapper) => (wrapper.firstElementChild ?? wrapper).getBoundingClientRect())
      // A control's right edge is its painted extent; read-only text has none.
      // An icon's margin counts, so a chevron inset like a select's lands on the field edge.
      const rights = spread(
        wrappers.flatMap((wrapper) => {
          const painted = [wrapper, ...wrapper.querySelectorAll<HTMLElement>("*")].filter((el) => {
            if (el.getBoundingClientRect().width === 0) return false
            if (el.matches("input, textarea, button, a, svg, [role=radiogroup], [role=combobox]")) return true
            const style = getComputedStyle(el)
            return parseFloat(style.borderRightWidth) > 0 || style.backgroundColor !== "rgba(0, 0, 0, 0)"
          })
          if (painted.length === 0) return []
          return [
            Math.max(
              ...painted.map((el) => el.getBoundingClientRect().right + parseFloat(getComputedStyle(el).marginRight))
            ),
          ]
        })
      )
      const overflowing =
        controls.some((rect) => rect.right > cardRight - 16 + 1) ||
        wrappers.some((wrapper) => wrapper.scrollWidth > wrapper.clientWidth + 1) ||
        [...card.querySelectorAll<HTMLElement>("[data-setting-control] button")].some(
          (button) => button.scrollWidth > button.clientWidth + 1
        )
      if (rights.length === 0 && !overflowing) return []
      return [{ section: section.querySelector("h3")?.textContent, rights, overflowing }]
    })
    const chevronRights = sections.flatMap((section) =>
      [...section.querySelectorAll<SVGElement>("svg.lucide-chevron-right, svg.lucide-chevron-down")]
        .filter((svg) => !svg.closest("ul.grid"))
        .map((svg) => svg.getBoundingClientRect())
        .filter((rect) => rect.width >= 16)
        .map((rect) => rect.right)
    )
    const chevrons = spread(chevronRights)
    // Where the text of each select, field and read-only value leading its control column starts.
    // A field after a prefix or another control isn't the column's leading text.
    const textLefts = [...content.querySelectorAll<HTMLElement>("[data-setting-control]")]
      .flatMap((wrapper) =>
        [
          ...wrapper.querySelectorAll<HTMLElement>(
            "[role=combobox], input:not([type=checkbox]):not([type=radio]), [data-setting-value]"
          ),
        ].filter(
          (el) =>
            el.getBoundingClientRect().width > 0 &&
            Math.abs(el.getBoundingClientRect().left - wrapper.getBoundingClientRect().left) <= 1
        )
      )
      .map((el) => {
        const style = getComputedStyle(el)
        return el.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
      })
    return {
      title: heading.textContent,
      heading: Math.round(heading.getBoundingClientRect().left),
      left: Math.round(Math.min(...rects.map((r) => r.left))),
      right: Math.round(Math.max(...rects.map((r) => r.right))),
      raggedCards,
      chevrons,
      textEdges: spread(textLefts),
    }
  })
}

/**
 * Segmented choices whose label breaks onto a second line. A wrapped label
 * keeps its scrollWidth, so only its line boxes show it.
 */
async function wrappedSegments(page: Page) {
  return page.getByRole("dialog").evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>("[role=radiogroup] > button[role=radio]")]
      .filter((segment) => {
        const range = document.createRange()
        range.selectNodeContents(segment)
        const lines = new Set(
          [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))
        )
        return lines.size > 1
      })
      .map((segment) => segment.textContent)
  )
}

/** Overview grids whose last row leaves a cell empty. */
async function overviewHoles(page: Page) {
  return page.getByRole("dialog").evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>("ul.grid")].flatMap((grid) => {
      const last = grid.lastElementChild?.getBoundingClientRect()
      if (!last || Math.abs(grid.getBoundingClientRect().right - last.right) <= 2) return []
      return [grid.lastElementChild?.textContent]
    })
  )
}

/** Overview row lines cut off by an ellipsis or a line clamp. */
async function clippedOverviewText(page: Page) {
  return page.getByRole("dialog").evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>("ul li a span")]
      .filter((el) => el.clientWidth > 0 && !el.closest(".sr-only"))
      .filter((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.textContent)
  )
}

/** The API requests in flight, past the socket's own transport. */
function trackApiRequests(page: Page): ReadonlySet<Request> {
  const inFlight = new Set<Request>()
  const isApi = (request: Request) =>
    ["fetch", "xhr"].includes(request.resourceType()) &&
    request.url().includes("/api/") &&
    !request.url().includes("/socket.io/")
  page.on("request", (request) => isApi(request) && inFlight.add(request))
  page.on("requestfinished", (request) => inFlight.delete(request))
  page.on("requestfailed", (request) => inFlight.delete(request))
  return inFlight
}

const LOADING = "[aria-busy=true], [data-slot=setting-control-skeleton], [class*='animate-pulse']"

/**
 * Waits until the open page has loaded what it shows: no request in flight and
 * no loading state, across two looks. A page can render before its first fetch
 * starts, or between one query and the one waiting on it, so a single look can
 * pass on a page that is about to show skeletons.
 */
async function waitForSettingsPage(page: Page, inFlight: ReadonlySet<Request>) {
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator("section").first()).toBeVisible({ timeout: 15000 })
  await expect(async () => {
    for (let look = 0; look < 2; look++) {
      if (look > 0) await page.waitForTimeout(250)
      expect({ requests: inFlight.size, loading: await dialog.locator(LOADING).count() }).toEqual({
        requests: 0,
        loading: 0,
      })
    }
  }).toPass({ timeout: 15000 })
}

/** Each overview scope's heading and the pages its rows open. */
async function overviewScopes(page: Page) {
  return page.getByRole("dialog").evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>("section[aria-labelledby^='settings-overview-']")].map((section) => ({
      scope: section.getAttribute("aria-labelledby"),
      hrefs: [...section.querySelectorAll("ul li a")].map((row) => row.getAttribute("href")!),
    }))
  )
}

test.describe("Settings layout", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("every desktop page shares the overview's edges and starts where its title starts; a card's controls share the right edge, row chevrons one x and control text one start", async ({
    page,
  }) => {
    test.setTimeout(90000)
    const inFlight = trackApiRequests(page)
    await loginAndCreateWorkspace(page, "settings-layout")
    const ws = page.url().match(/\/w\/(ws_[^/?]+)/)![1]
    const channelId = await createChannelViaApi(page, ws, `settings-layout-${Date.now().toString(36)}`, "public")
    await page.goto(`/w/${ws}/s/${channelId}?settings=`)
    const nav = page.getByRole("dialog").getByRole("navigation", { name: "Settings pages" })
    await expect(nav.getByRole("link").first()).toBeVisible({ timeout: 15000 })
    await waitForSettingsPage(page, inFlight)
    const overview = await edges(page)
    const holes = await overviewHoles(page)

    const misaligned: unknown[] = []
    const ragged: unknown[] = []
    const wrapped: unknown[] = []
    const scattered: unknown[] = []
    const textEdges: unknown[] = []
    const links = nav.getByRole("link")
    for (let i = 0; i < (await links.count()); i++) {
      await links.nth(i).click()
      await expect(links.nth(i)).toHaveAttribute("aria-current", "page")
      await waitForSettingsPage(page, inFlight)
      const current = await edges(page)
      if (current.left !== current.heading || current.left !== overview.left || current.right !== overview.right) {
        misaligned.push({ title: current.title, heading: current.heading, left: current.left, right: current.right })
      }
      if (current.raggedCards.length > 0) ragged.push({ title: current.title, cards: current.raggedCards })
      if (current.chevrons.length > 0) scattered.push({ title: current.title, chevrons: current.chevrons })
      if (current.textEdges.length > 0) textEdges.push({ title: current.title, edges: current.textEdges })
      const segments = await wrappedSegments(page)
      if (segments.length > 0) wrapped.push({ title: current.title, segments })
    }
    expect({
      overviewStartsAtTitle: overview.left === overview.heading,
      holes,
      misaligned,
      ragged,
      wrapped,
      scattered,
      textEdges,
    }).toEqual({
      overviewStartsAtTitle: true,
      holes: [],
      misaligned: [],
      ragged: [],
      wrapped: [],
      scattered: [],
      textEdges: [],
    })
  })
})

test.describe("Settings layout on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test("overview rows show their whole value and coverage; no segmented label wraps", async ({ page }) => {
    test.setTimeout(180000)
    const inFlight = trackApiRequests(page)
    await loginAndCreateWorkspace(page, "settings-layout-phone")
    const ws = page.url().match(/\/w\/(ws_[^/?]+)/)![1]
    const channelId = await createChannelViaApi(page, ws, `settings-phone-${Date.now().toString(36)}`, "public")
    await page.goto(`/w/${ws}/s/${channelId}?settings=`)
    const dialog = page.getByRole("dialog")
    await expect(dialog.locator("ul li a").first()).toBeVisible({ timeout: 15000 })
    await waitForSettingsPage(page, inFlight)
    const clipped = await clippedOverviewText(page)
    const scopes = await overviewScopes(page)
    const atPath = (href: string) => (url: URL) => url.pathname + url.search === href
    const overviewHref = await page.evaluate(() => location.pathname + location.search)

    const wrapped: unknown[] = []
    for (const href of new Set(scopes.flatMap((scope) => scope.hrefs))) {
      await dialog.locator(`ul li a[href="${href}"]`).first().click()
      await page.waitForURL(atPath(href))
      await waitForSettingsPage(page, inFlight)
      const segments = await wrappedSegments(page)
      if (segments.length > 0) wrapped.push({ href, segments })
      await page.goBack()
      await page.waitForURL(atPath(overviewHref))
      await waitForSettingsPage(page, inFlight)
    }
    expect({
      clipped,
      wrapped,
      scopesWithRows: scopes.filter((scope) => scope.hrefs.length > 0).map((scope) => scope.scope),
    }).toEqual({
      clipped: [],
      wrapped: [],
      scopesWithRows: ["settings-overview-stream", "settings-overview-you", "settings-overview-workspace"],
    })
  })
})
