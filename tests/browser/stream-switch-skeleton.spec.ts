import { test, expect, type Page } from "@playwright/test"
import {
  createChannelViaApi,
  expandCollapsedSidebarSections,
  loginAndCreateWorkspace,
  openPhoneSidebar,
} from "./helpers"
import { seedStream } from "./perf-fixtures"

interface SwitchFrame {
  time: number
  skeleton: boolean
  mask: boolean
  rows: boolean
}

interface SwitchProbeWindow extends Window {
  switchFrames: SwitchFrame[]
  releaseEventWriter?: () => void
}

async function recordSwitch(page: Page, href: string, streamId: string) {
  await page.evaluate(
    ({ href, streamId }) => {
      const probe = window as SwitchProbeWindow
      probe.switchFrames = []
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).find(
        (link) => link.getAttribute("href") === href && link.checkVisibility()
      )!
      link.addEventListener(
        "click",
        () => {
          const started = performance.now()
          let revealedAt: number | undefined
          const sample = () => {
            const time = performance.now() - started
            const main = document.querySelector("main")
            const rows = !!main?.querySelector(`[data-stream-scroller="${streamId}"] .message-item`)
            const mask = !!main?.querySelector('[data-testid="settle-mask"]')
            const skeleton = Array.from(main?.querySelectorAll<HTMLElement>(".animate-pulse.bg-muted") ?? []).some(
              (node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            )
            probe.switchFrames.push({ time, skeleton, mask, rows })
            if (rows && !mask) revealedAt ??= time
            if (time < 15_000 && (revealedAt === undefined || time < revealedAt + 50)) requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        },
        { once: true, capture: true }
      )
    },
    { href, streamId }
  )
}

async function holdEventWriter(page: Page) {
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find((db) => db.name?.startsWith("threa_v2_"))?.name
    if (!name) throw new Error("The warmed account database is missing")
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction("eventsByWorkspace", "readwrite")
        const store = tx.objectStore("eventsByWorkspace")
        let hold = true
        const deadline = window.setTimeout(() => tx.abort(), 15_000)
        ;(window as SwitchProbeWindow).releaseEventWriter = () => {
          hold = false
        }
        tx.oncomplete = tx.onabort = () => {
          clearTimeout(deadline)
          db.close()
          delete (window as SwitchProbeWindow).releaseEventWriter
        }
        const keepOpen = () => {
          const request = store.count()
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            resolve()
            if (hold) keepOpen()
          }
        }
        keepOpen()
      }
    })
  })
}

test("should delay the skeleton on cached phone switches and still show it for a blocked read", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await loginAndCreateWorkspace(page, "skeleton-delay")
  const workspaceId = page.url().match(/\/w\/([^/]+)/)![1]
  const streams: string[] = []
  for (const suffix of ["a", "b"]) {
    const streamId = await createChannelViaApi(page, workspaceId, `skeleton-${suffix}-${Date.now().toString(36)}`)
    await seedStream(page, workspaceId, streamId, 30, `history-${suffix}`)
    streams.push(streamId)
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.locator(".message-item").filter({ hasText: `history-${suffix} msg-0030` })).toBeVisible()
    await expect(page.getByTestId("settle-mask")).toHaveCount(0)
  }
  await page.setViewportSize({ width: 388, height: 854 })

  for (const scenario of ["online", "offline", "blocked"] as const) {
    await test.step(scenario, async () => {
      await context.setOffline(scenario === "offline")
      await openPhoneSidebar(page)
      await expandCollapsedSidebarSections(page)
      const streamId = streams[scenario === "offline" ? 1 : 0]
      const href = `/w/${workspaceId}/s/${streamId}`
      if (scenario === "blocked") await holdEventWriter(page)
      await recordSwitch(page, href, streamId)
      try {
        await page.locator(`a[href="${href}"]`).filter({ visible: true }).first().click()
        if (scenario === "blocked") {
          await expect
            .poll(() => page.evaluate(() => (window as SwitchProbeWindow).switchFrames.some((frame) => frame.skeleton)))
            .toBe(true)
          await page.evaluate(() => (window as SwitchProbeWindow).releaseEventWriter?.())
        }
        await expect(page.locator(`[data-stream-scroller="${streamId}"] .message-item`).first()).toBeVisible()
        await expect(page.getByTestId("settle-mask")).toHaveCount(0)
        const frames = await page.evaluate(() => (window as SwitchProbeWindow).switchFrames)
        expect(frames.filter((frame) => frame.skeleton && frame.time < 600)).toEqual([])
      } finally {
        await page.evaluate(() => (window as SwitchProbeWindow).releaseEventWriter?.())
        await context.setOffline(false)
      }
    })
  }
})
