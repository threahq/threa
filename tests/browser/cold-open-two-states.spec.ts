import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test"
import {
  clickReplyInThread,
  expectApiOk,
  loginAndCreateWorkspace,
  sendPanelReply,
  waitForRealThreadPanel,
} from "./helpers"

/**
 * Two states only. A cold open paints what IndexedDB holds at once, then
 * everything that changed while the tab was gone lands in ONE render. The bug
 * this guards: opening the desktop app after weeks away and watching the
 * sidebar replay messages already read on the phone, row by row.
 *
 * Regions watched: sidebar rows (name, unread weight, preview text), the main
 * timeline's rendered event ids, the thread panel's. A MutationObserver
 * installed before the app script runs records every distinct combination. A
 * region under its settle mask counts as not painted yet and a region's first
 * paint is free (INV-70 masks positional landings for a few frames). The rule:
 *   - a region shows at most two values, the pre-close state then the final
 *     state, and
 *   - every region that changes does so in the same mutation batch.
 *
 * The gap is opened by closing the page (no socket), posting through a second
 * member's API context, and opening a new page in the same browser context, so
 * IndexedDB and the service worker cache survive as on a real desktop. The
 * service-worker arm (hide the tab so `push-bootstrap` caches a snapshot) only
 * fires under the production build (`PLAYWRIGHT_PROD_FRONTEND=1`); the dev
 * server registers no worker, so there the spec covers catch-up alone.
 */

test.describe.configure({ timeout: 240_000 })

/** Past any real sync id, so the head probe returns the head and no entries. */
const HEAD_PROBE_CURSOR = "9223372036854775807"
/** `CATCHUP_COLLAPSE_THRESHOLD` in `apps/frontend/src/sync/sync-engine.ts`. */
const COLLAPSE_THRESHOLD = 200
/** Well past any client-side wait; the apply window has no timer, so a slow catch-up must not expose partial state. */
const SLOW_CATCHUP_DELAY_MS = 6_500
const QUIET_MS = 2_500
/**
 * The channel timeline's rows land in the sweep's render, but the virtualizer
 * measures fresh rows through a ResizeObserver and refines the tail's scroll
 * offset over the next frame or two (virtua's `scrollToIndex` loops until every
 * row in range is measured). That refine moves which row is the newest rendered
 * one without changing what landed, so a timeline-only change this soon after
 * a batch that already moved the timeline is folded into that batch.
 */
const TAIL_SETTLE_MS = 600

interface RegionSnapshot {
  sidebar: string | null
  timeline: string | null
  panel: string | null
}

interface RecordedSnapshot {
  t: number
  snap: RegionSnapshot
}

/** Runs in the page. Serialised with `toString()`, so no outer references. */
function snapshotRegions(): RegionSnapshot {
  const nav = document.querySelector('[role="navigation"][aria-label="Sidebar navigation"]')
  const rows = nav ? Array.from(nav.querySelectorAll('a[href*="/s/"]')) : []
  // The open stream's own row is left out: viewing it marks it read (debounced
  // auto-read), which unbolds and re-sorts that one row a moment after the gap
  // lands. That is the viewer reading, not a load; the timeline region covers
  // the open stream's content.
  const openStream = location.pathname.match(/\/s\/([^/]+)/)?.[1]
  const sidebar =
    rows.length === 0
      ? null
      : rows
          .filter((link) => !openStream || !link.getAttribute("href")?.includes(`/s/${openStream}`))
          .map((link) => {
            const name = link.querySelector("span.text-sm.truncate")
            const preview = link.querySelector("span.flex-1.truncate")
            const unread = name?.classList.contains("font-semibold") ? "*" : ""
            return `${unread}${name?.textContent?.trim() ?? "?"} | ${preview?.textContent?.trim() ?? ""}`
          })
          .join("\n")
  // A timeline's state is its newest rendered row: the virtualizer's mounted
  // window above the tail grows and shrinks as it measures, which is not a
  // visible change. The channel timeline is masked while it settles; the thread
  // panel renders a plain scroller with no mask.
  const tailOf = (root: Element | null): string | null => {
    if (!root) return null
    if (root.querySelector('[data-testid="settle-mask"]')) return null
    const rows = root.querySelectorAll("[data-event-id]")
    return rows.length === 0 ? null : rows[rows.length - 1].getAttribute("data-event-id")
  }
  return {
    sidebar,
    timeline: tailOf(document.querySelector('main[data-editor-zone="main"]')),
    panel: tailOf(document.querySelector('[data-testid="panel"]')),
  }
}

/** Runs in the page from document start; `snapshotRegions` is inlined ahead of it. */
function installRegionObserver(): void {
  const records: RecordedSnapshot[] = []
  ;(window as unknown as { __coldOpenRecords: RecordedSnapshot[] }).__coldOpenRecords = records
  let last = ""
  const observer = new MutationObserver(() => {
    const snap = snapshotRegions()
    const key = JSON.stringify(snap)
    if (key === last) return
    last = key
    records.push({ t: Math.round(performance.now()), snap })
  })
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class", "data-event-id", "data-testid"],
  })
}

const OBSERVER_SOURCE = `${snapshotRegions.toString()}\n${installRegionObserver.toString()}\ninstallRegionObserver()`

function readRecords(page: Page): Promise<RecordedSnapshot[]> {
  return page.evaluate(() => (window as unknown as { __coldOpenRecords?: RecordedSnapshot[] }).__coldOpenRecords ?? [])
}

const REGIONS = ["sidebar", "timeline", "panel"] as const

interface Analysis {
  /** Distinct consecutive painted values per region, masked/absent frames skipped. */
  paints: Record<(typeof REGIONS)[number], string[]>
  /** Record indices at which some already-painted region changed value. */
  changes: number[]
}

function analyse(records: RecordedSnapshot[]): Analysis {
  const paints = { sidebar: [] as string[], timeline: [] as string[], panel: [] as string[] }
  const changedAt = new Map<number, Set<(typeof REGIONS)[number]>>()
  for (const region of REGIONS) {
    let prev: string | null = null
    records.forEach((record, index) => {
      const value = record.snap[region]
      if (value === null) return
      if (prev !== null && value !== prev) {
        const regions = changedAt.get(index) ?? new Set()
        regions.add(region)
        changedAt.set(index, regions)
      }
      if (paints[region][paints[region].length - 1] !== value) paints[region].push(value)
      prev = value
    })
  }
  const changes: number[] = []
  for (const index of [...changedAt.keys()].sort((a, b) => a - b)) {
    const regions = changedAt.get(index)!
    const last = changes.at(-1)
    const isTailSettle =
      last !== undefined &&
      regions.size === 1 &&
      regions.has("timeline") &&
      changedAt.get(last)!.has("timeline") &&
      records[index].t - records[last].t <= TAIL_SETTLE_MS
    if (isTailSettle) {
      const tails = paints.timeline
      tails.splice(tails.length - 2, 1)
      continue
    }
    changes.push(index)
  }
  return { paints, changes }
}

function describeRecords(records: RecordedSnapshot[]): string {
  return records
    .map((r, i) => {
      const sidebar = r.snap.sidebar === null ? "-" : r.snap.sidebar.replace(/\n/g, " || ")
      const timeline = r.snap.timeline ?? "-"
      const panel = r.snap.panel ?? "-"
      return `#${i} t=${r.t}ms sidebar=[${sidebar}] timeline=${timeline} panel=${panel}`
    })
    .join("\n")
}

async function apiLogin(baseURL: string, email: string, name: string): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({ baseURL })
  await expectApiOk(await api.post("/api/dev/login", { data: { email, name } }), `login ${email}`)
  return api
}

async function createChannel(api: APIRequestContext, workspaceId: string, slug: string): Promise<string> {
  const response = await api.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug, visibility: "public" },
  })
  await expectApiOk(response, `create #${slug}`)
  return ((await response.json()) as { stream: { id: string } }).stream.id
}

async function postMessage(api: APIRequestContext, workspaceId: string, streamId: string, content: string) {
  await expectApiOk(
    await api.post(`/api/workspaces/${workspaceId}/messages`, { data: { streamId, content } }),
    `post "${content}"`
  )
}

async function syncHead(api: APIRequestContext, workspaceId: string): Promise<bigint> {
  const response = await api.get(`/api/workspaces/${workspaceId}/sync?after=${HEAD_PROBE_CURSOR}&limit=1`)
  await expectApiOk(response, "read sync head")
  return BigInt(((await response.json()) as { head: string }).head)
}

async function markRead(api: APIRequestContext, workspaceId: string, streamId: string): Promise<void> {
  const list = await api.get(`/api/workspaces/${workspaceId}/streams/${streamId}/events?limit=50`)
  await expectApiOk(list, "list events for read marker")
  const events = ((await list.json()) as { events: Array<{ id: string; sequence: string | number }> }).events
  const latest = [...events].sort((a, b) => Number(a.sequence) - Number(b.sequence)).at(-1)
  if (!latest) throw new Error(`no events to mark read in ${streamId}`)
  await expectApiOk(
    await api.post(`/api/workspaces/${workspaceId}/streams/${streamId}/read`, { data: { lastEventId: latest.id } }),
    "mark read"
  )
}

async function readIdbRows<T>(page: Page, table: string): Promise<T[]> {
  return page.evaluate(async (tableName) => {
    const out: unknown[] = []
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue
      const rows = await new Promise<unknown[]>((resolve) => {
        const req = indexedDB.open(name)
        req.onerror = () => resolve([])
        req.onsuccess = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(tableName)) {
            db.close()
            return resolve([])
          }
          const get = db.transaction(tableName, "readonly").objectStore(tableName).getAll()
          get.onerror = () => {
            db.close()
            resolve([])
          }
          get.onsuccess = () => {
            db.close()
            resolve(get.result)
          }
        }
      })
      out.push(...rows)
    }
    return out as T[]
  }, table) as Promise<T[]>
}

async function swControls(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    if (!navigator.serviceWorker) return false
    await navigator.serviceWorker.ready.catch(() => null)
    return !!navigator.serviceWorker.controller
  })
}

/** Lock the phone: the hide handler has the SW cache the bootstrap as it stands. */
async function cacheSnapshotInServiceWorker(page: Page, workspaceId: string): Promise<boolean> {
  if (!(await swControls(page))) return false
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect
    .poll(
      () =>
        page.evaluate(async (wid) => {
          const cache = await caches.open("push-bootstrap")
          return !!(await cache.match(`/api/workspaces/${wid}/bootstrap`))
        }, workspaceId),
      { timeout: 15000, message: "SW never cached the bootstrap on hide" }
    )
    .toBe(true)
  return true
}

interface Fixture {
  testId: string
  workspaceId: string
  url: string
  home: string
  thread: string
  readElsewhere: string
  unreadElsewhere: string
  renamed: string
  renamedSlug: string
  doomed: string
  doomedSlug: string
  owner: APIRequestContext
  other: APIRequestContext
  otherName: string
  before: RegionSnapshot
  swArmed: boolean
}

/**
 * Owner opens #home with a thread panel; a second member seeds a preview into
 * every channel while the owner is online, so the pre-close state has real
 * previews, unread rows and a populated panel. Then the tab hides (SW snapshot)
 * and the page closes.
 */
async function arrange(page: Page, context: BrowserContext): Promise<Fixture> {
  const { testId } = await loginAndCreateWorkspace(page, "cold-open")
  const workspaceId = page.url().match(/\/w\/([^/?]+)/)![1]
  const baseURL = new URL(page.url()).origin
  const owner = context.request

  const slugs = {
    home: `home-${testId}`,
    readElsewhere: `read-elsewhere-${testId}`,
    unreadElsewhere: `unread-elsewhere-${testId}`,
    renamed: `renamed-${testId}`,
    doomed: `doomed-${testId}`,
  }
  const ids = {
    home: await createChannel(owner, workspaceId, slugs.home),
    readElsewhere: await createChannel(owner, workspaceId, slugs.readElsewhere),
    unreadElsewhere: await createChannel(owner, workspaceId, slugs.unreadElsewhere),
    renamed: await createChannel(owner, workspaceId, slugs.renamed),
    doomed: await createChannel(owner, workspaceId, slugs.doomed),
  }

  const otherName = `Other ${testId}`
  const other = await apiLogin(baseURL, `cold-open-other-${testId}@example.com`, otherName)
  await expectApiOk(
    await other.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
    "other joins workspace"
  )
  for (const streamId of Object.values(ids)) {
    await expectApiOk(
      await other.post(`/api/workspaces/${workspaceId}/streams/${streamId}/join`),
      "other joins channel"
    )
  }

  await page.goto(`/w/${workspaceId}/s/${ids.home}`)
  await expect(page.getByRole("heading", { name: `#${slugs.home}`, level: 1 })).toBeVisible({ timeout: 10000 })

  const parentMessage = `parent ${testId}`
  await page.locator("[contenteditable='true']").click()
  await page.keyboard.type(parentMessage)
  await page.keyboard.press("Meta+Enter")
  const parentRow = page.getByRole("main").locator(".message-item").filter({ hasText: parentMessage }).first()
  await expect(parentRow).toBeVisible({ timeout: 10000 })
  await clickReplyInThread(parentRow)
  await expect(page.getByText(/Start a new thread/)).toBeVisible({ timeout: 10000 })
  await sendPanelReply(page, `first reply ${testId}`)
  await expect(page.getByTestId("panel").getByText(`first reply ${testId}`)).toBeVisible({ timeout: 10000 })
  await waitForRealThreadPanel(page)
  const thread = new URL(page.url()).searchParams.get("panel")!
  expect(thread.startsWith("draft:")).toBe(false)

  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  for (const [key, streamId] of Object.entries(ids)) {
    await postMessage(other, workspaceId, streamId, `seed ${key} ${testId}`)
    await expect(nav.locator("a", { hasText: `seed ${key} ${testId}` })).toBeVisible({ timeout: 15000 })
  }
  await postMessage(other, workspaceId, thread, `seed thread ${testId}`)
  await expect(page.getByTestId("panel").getByText(`seed thread ${testId}`)).toBeVisible({ timeout: 15000 })

  // The handler writes behind those live events are not awaited by anything
  // the page exposes; wait for IndexedDB to hold them before closing.
  await expect
    .poll(
      async () => {
        const streams = await readIdbRows<{ id: string; lastMessagePreview?: { content: string } | null }>(
          page,
          "streams"
        )
        const events = await readIdbRows<{ streamId: string }>(page, "events")
        const previews = Object.values(ids).every((id) =>
          streams.some((s) => s.id === id && s.lastMessagePreview?.content.includes("seed"))
        )
        return previews && events.filter((e) => e.streamId === thread).length >= 2
      },
      { timeout: 15000, message: "IndexedDB never caught up with the live seed" }
    )
    .toBe(true)

  const swArmed = await cacheSnapshotInServiceWorker(page, workspaceId)
  const before = await page.evaluate(snapshotRegions)
  expect(before.sidebar, "pre-close sidebar painted").not.toBeNull()
  expect(before.timeline, "pre-close timeline painted").not.toBeNull()
  expect(before.panel, "pre-close panel painted").not.toBeNull()
  const url = page.url()
  await page.close()

  return {
    testId,
    workspaceId,
    url,
    home: ids.home,
    thread,
    readElsewhere: ids.readElsewhere,
    unreadElsewhere: ids.unreadElsewhere,
    renamed: ids.renamed,
    renamedSlug: slugs.renamed,
    doomed: ids.doomed,
    doomedSlug: slugs.doomed,
    owner,
    other,
    otherName,
    before,
    swArmed,
  }
}

interface GapShape {
  /** Stop once the head has advanced by at least this many entries. */
  atLeast: number
  /** Never let the head advance past this; posts go one at a time near the ceiling. */
  atMost?: number
}

/**
 * Everything the phone did while the desktop was closed: new messages in the
 * open channel and its thread, messages elsewhere (one channel then read from
 * the phone, one left unread), a rename, an archive, then filler in #home
 * until the sync head has moved by the requested amount. Returns the delta.
 */
async function openGap(f: Fixture, shape: GapShape): Promise<{ delta: number; lastHome: string; lastThread: string }> {
  const start = await syncHead(f.other, f.workspaceId)
  const { workspaceId } = f

  await postMessage(f.other, workspaceId, f.home, `gap home 1 ${f.testId}`)
  await postMessage(f.other, workspaceId, f.readElsewhere, `gap read-elsewhere ${f.testId}`)
  await postMessage(f.other, workspaceId, f.unreadElsewhere, `gap unread-elsewhere ${f.testId}`)
  const lastThread = `gap thread ${f.testId}`
  await postMessage(f.other, workspaceId, f.thread, lastThread)
  await markRead(f.owner, workspaceId, f.readElsewhere)
  await expectApiOk(
    await f.owner.patch(`/api/workspaces/${workspaceId}/streams/${f.renamed}`, {
      data: { slug: `${f.renamedSlug}-v2` },
    }),
    "rename channel"
  )
  await expectApiOk(await f.owner.post(`/api/workspaces/${workspaceId}/streams/${f.doomed}/archive`), "archive channel")

  // One message fans out into several sync entries (the event, the preview,
  // one counter per member), and the count varies by message, so the filler
  // is posted one at a time near the ceiling and stops two messages short of
  // it by the largest fan-out seen so far.
  let lastHome = `gap home 1 ${f.testId}`
  let head = await syncHead(f.other, workspaceId)
  let perMessage = 4
  let n = 1
  while (head - start < BigInt(shape.atLeast)) {
    const delta = Number(head - start)
    if (shape.atMost !== undefined && delta + perMessage * 2 > shape.atMost) break
    const remaining = shape.atLeast - delta
    const nearCeiling = shape.atMost !== undefined && shape.atMost - delta < perMessage * 6
    const batch = nearCeiling ? 1 : Math.max(1, Math.min(5, Math.ceil(remaining / perMessage)))
    for (let i = 0; i < batch; i++) {
      n += 1
      lastHome = `gap home ${n} ${f.testId}`
      await postMessage(f.other, workspaceId, f.home, lastHome)
    }
    const next = await syncHead(f.other, workspaceId)
    perMessage = Math.max(perMessage, Math.ceil(Number(next - head) / batch))
    head = next
  }
  return { delta: Number(head - start), lastHome, lastThread }
}

interface Reopened {
  page: Page
  records: RecordedSnapshot[]
  analysis: Analysis
}

/** Open a new page at the same URL with the observer installed, wait for the gap to land, then for quiet. */
async function reopen(
  context: BrowserContext,
  f: Fixture,
  landed: { lastHome: string; lastThread: string } | null,
  options: { slowCatchUp?: boolean } = {}
): Promise<Reopened> {
  const page = await context.newPage()
  await page.addInitScript({ content: OBSERVER_SOURCE })
  if (options.slowCatchUp) {
    await page.route("**/api/workspaces/*/sync?**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_CATCHUP_DELAY_MS))
      await route.continue()
    })
  }
  await page.goto(f.url)

  const nav = page.getByRole("navigation", { name: "Sidebar navigation" })
  await expect(nav.locator('a[href*="/s/"]').first()).toBeVisible({ timeout: 20000 })
  if (landed) {
    await expect(nav.locator("a", { hasText: landed.lastHome })).toBeVisible({ timeout: 40000 })
    await expect(nav.locator("a", { hasText: `${f.renamedSlug}-v2` })).toBeVisible({ timeout: 40000 })
    await expect(page.getByRole("main").locator(".message-item", { hasText: landed.lastHome })).toBeVisible({
      timeout: 40000,
    })
    await expect(page.getByTestId("panel").locator(".message-item", { hasText: landed.lastThread })).toBeVisible({
      timeout: 40000,
    })
  } else {
    await expect(page.getByTestId("panel").getByText(`seed thread ${f.testId}`)).toBeVisible({ timeout: 20000 })
  }

  let seen = -1
  await expect
    .poll(
      async () => {
        const count = (await readRecords(page)).length
        if (count === seen) return "quiet"
        seen = count
        await page.waitForTimeout(QUIET_MS)
        return "moving"
      },
      { timeout: 60000, message: "the DOM never went quiet after the reopen" }
    )
    .toBe("quiet")

  const records = await readRecords(page)
  return { page, records, analysis: analyse(records) }
}

function expectTwoStates(f: Fixture, { records, analysis }: Reopened, expectChange: boolean): void {
  const trail = `\n${describeRecords(records)}`
  for (const region of REGIONS) {
    expect(analysis.paints[region][0], `${region} first paint is the cached state${trail}`).toBe(f.before[region])
    expect(
      analysis.paints[region].length,
      `${region} painted ${analysis.paints[region].length} distinct states, at most 2 allowed${trail}`
    ).toBeLessThanOrEqual(2)
  }
  expect(
    analysis.changes.length,
    `regions changed in ${analysis.changes.length} separate mutation batches (${analysis.changes.join(", ")}); ${
      expectChange ? "one" : "none"
    } allowed${trail}`
  ).toBe(expectChange ? 1 : 0)
}

test.describe("Cold open lands in two states", () => {
  test("no gap: the cached state paints once and nothing moves", async ({ page, context }) => {
    const f = await arrange(page, context)
    const reopened = await reopen(context, f, null)
    expectTwoStates(f, reopened, false)
  })

  test("a small gap lands in one render", async ({ page, context }) => {
    const f = await arrange(page, context)
    const gap = await openGap(f, { atLeast: 10 })
    expect(gap.delta).toBeLessThan(COLLAPSE_THRESHOLD)
    const reopened = await reopen(context, f, gap)
    expectTwoStates(f, reopened, true)
    const finalSidebar = reopened.analysis.paints.sidebar.at(-1)!
    await expect(
      reopened.page.getByRole("navigation", { name: "Sidebar navigation" }).locator(`a[href*="/s/${f.home}"]`)
    ).toContainText(gap.lastHome)
    expect(finalSidebar).not.toContain(`#${f.renamedSlug} |`)
    expect(finalSidebar).toContain(`#${f.renamedSlug}-v2 |`)
    expect(finalSidebar).not.toContain(`*#read-elsewhere-${f.testId} |`)
    expect(finalSidebar).toContain(`*#unread-elsewhere-${f.testId} |`)
  })

  test("a gap just under the collapse threshold lands in one render", async ({ page, context }) => {
    const f = await arrange(page, context)
    const gap = await openGap(f, { atLeast: COLLAPSE_THRESHOLD - 30, atMost: COLLAPSE_THRESHOLD - 1 })
    expect(gap.delta).toBeLessThan(COLLAPSE_THRESHOLD)
    const reopened = await reopen(context, f, gap)
    expectTwoStates(f, reopened, true)
  })

  test("a gap past the collapse threshold lands in one render", async ({ page, context }) => {
    const f = await arrange(page, context)
    const gap = await openGap(f, { atLeast: COLLAPSE_THRESHOLD + 20 })
    expect(gap.delta).toBeGreaterThanOrEqual(COLLAPSE_THRESHOLD)
    const reopened = await reopen(context, f, gap)
    expectTwoStates(f, reopened, true)
  })

  test("a slow catch-up keeps the cached state until everything lands", async ({ page, context }) => {
    const f = await arrange(page, context)
    const gap = await openGap(f, { atLeast: 10 })
    const reopened = await reopen(context, f, gap, { slowCatchUp: true })
    expectTwoStates(f, reopened, true)
  })
})
