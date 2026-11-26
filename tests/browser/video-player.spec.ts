import { test, expect, type Page, type Response } from "@playwright/test"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"
import { loginAndCreateWorkspace, createChannelViaApi, workspaceIdFromUrl } from "./helpers"

/**
 * The gallery's own video controls in a real browser: hit-testing against the
 * dialog's overlays, media seeking, pointer capture on the scrub bar and touch
 * gestures are all things jsdom's inert media element can't answer. Fixtures
 * are synthetic VP9 WebM (bundled Chromium has no H.264): 45s, a keyframe
 * every second, portrait 480x854 (taller than the desktop dialog) and landscape
 * 854x480. With ffmpeg on PATH the backend builds a storyboard sprite and the
 * bubble shows its tiles; without it (CI) the bubble decodes frames itself.
 */

test.describe.configure({ timeout: 150_000 })

const PORTRAIT = "video-portrait.webm"
const LANDSCAPE = "video-landscape.webm"
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

const player = (page: Page) => page.locator("[data-media-player]")
const chrome = (page: Page) => page.locator("[data-media-chrome]")
const scrub = (page: Page) => page.locator("[data-media-scrub]")
const spriteFrame = (page: Page) => chrome(page).locator("[data-storyboard-frame]")

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0

const pathOf = (response: Response) => new URL(response.url()).pathname

/** Resolves once the page's storyboard poll answers `ready`; register before opening the video. */
const storyboardReady = (page: Page) =>
  page.waitForResponse(
    async (r) =>
      r.request().method() === "POST" &&
      /\/attachments\/[^/]+\/storyboard$/.test(pathOf(r)) &&
      (await r.json().catch(() => null))?.status === "ready",
    { timeout: 120_000 }
  )

/** The sprite image's final response, following any storage redirect. */
const spriteResponse = (page: Page) =>
  page.waitForResponse(
    (r) => {
      for (let req: ReturnType<Response["request"]> | null = r.request(); req; req = req.redirectedFrom()) {
        if (/\/storyboard\/sprite$/.test(new URL(req.url()).pathname)) return r.status() < 300 || r.status() >= 400
      }
      return false
    },
    { timeout: 120_000 }
  )

async function expectSpriteServed(page: Page, sprite: Promise<Response>): Promise<void> {
  const response = await sprite
  expect({ status: response.status(), type: response.headers()["content-type"] }).toEqual({
    status: 200,
    type: "image/jpeg",
  })
}

interface VideoState {
  time: number
  duration: number
  paused: boolean
  rate: number
  src: string
}

const videoState = (page: Page) =>
  page.evaluate((): VideoState => {
    const v = document.querySelector<HTMLVideoElement>("[data-media-player] video")
    if (!v) throw new Error("no player video")
    return { time: v.currentTime, duration: v.duration, paused: v.paused, rate: v.playbackRate, src: v.currentSrc }
  })

async function seekTo(page: Page, time: number): Promise<void> {
  await page.evaluate((t) => {
    const v = document.querySelector<HTMLVideoElement>("[data-media-player] video")!
    v.currentTime = t
  }, time)
  await expect.poll(async () => (await videoState(page)).time).toBeCloseTo(time, 0)
}

async function seedVideos(page: Page, prefix: string): Promise<{ workspaceId: string; streamId: string }> {
  const { testId } = await loginAndCreateWorkspace(page, prefix)
  const workspaceId = workspaceIdFromUrl(page)
  const streamId = await createChannelViaApi(page, workspaceId, `${prefix}-${testId}`, "public")
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  const root = page.locator("[data-message-composer-root]").first()
  await expect(root).toBeVisible({ timeout: 20_000 })
  await root.locator('input[type="file"][multiple]').setInputFiles([fixture(PORTRAIT), fixture(LANDSCAPE)])
  const send = root.getByRole("button", { name: "Send", exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()
  await expect(page.getByRole("button", { name: PORTRAIT, exact: true })).toBeVisible({ timeout: 30_000 })
  return { workspaceId, streamId }
}

async function openVideo(page: Page, filename: string, tap = false): Promise<void> {
  const tile = page.getByRole("button", { name: filename, exact: true })
  // A tile that is still settling ignores the click; an open gallery covers the tile.
  await expect(async () => {
    if (!(await player(page).isVisible())) {
      if (tap) await tile.tap({ timeout: 2_000 })
      else await tile.click({ timeout: 2_000 })
    }
    await expect(player(page)).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 30_000 })
  await expect.poll(async () => (await videoState(page)).duration, { timeout: 15_000 }).toBeGreaterThan(40)
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox()
  if (!b) throw new Error(`no box for ${selector}`)
  return b
}

test.describe("Video player — desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("portrait video: controls are hit-testable, click plays, drag scrubs live", async ({ page }) => {
    await seedVideos(page, "video-desk")
    await openVideo(page, PORTRAIT)

    const surface = await box(page, "[data-media-player]")
    expect(await box(page, "[data-media-player] video"), "the poster is drawn in the stage's box").toEqual(surface)

    const hit = await page.evaluate(() => {
      const owner = (selector: string, owns: string) => {
        const el = document.querySelector(selector)!
        const r = el.getBoundingClientRect()
        return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(owns)
      }
      return {
        centerPlay: owner("[data-media-player] > button", "[data-media-player] > button"),
        scrub: owner("[data-media-scrub]", "[data-media-scrub]"),
        chromeButtons: [...document.querySelectorAll("[data-media-chrome] button")].every((b) => {
          const r = b.getBoundingClientRect()
          return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("button") === b
        }),
      }
    })
    expect(hit).toEqual({ centerPlay: true, scrub: true, chromeButtons: true })

    await page.locator("[data-media-player] > button").click()
    await expect.poll(async () => (await videoState(page)).paused).toBe(false)
    await expect.poll(async () => (await videoState(page)).time).toBeGreaterThan(0.5)
    expect(await box(page, "[data-media-player] video"), "the playing video keeps the poster's box").toEqual(surface)

    const bar = await box(page, "[data-media-scrub]")
    const y = bar.y + bar.height / 2
    await page.mouse.move(bar.x + bar.width * 0.2, y)
    await page.mouse.down()
    await page.mouse.move(bar.x + bar.width * 0.6, y, { steps: 10 })
    const { duration } = await videoState(page)
    await expect
      .poll(
        async () => {
          const s = await videoState(page)
          return s.paused && Math.abs(s.time - duration * 0.6) < 1.5
        },
        { message: "while held, the main video shows the frame under the thumb" }
      )
      .toBe(true)
    await page.mouse.move(bar.x + bar.width * 0.3, y, { steps: 10 })
    await expect.poll(async () => Math.abs((await videoState(page)).time - duration * 0.3) < 1.5).toBe(true)
    await page.mouse.up()
    await expect.poll(async () => (await videoState(page)).paused, { message: "release resumes" }).toBe(false)

    // The drag left focus on the seek thumb; the player's keys still answer from there.
    await page.keyboard.press("Space")
    await expect.poll(async () => (await videoState(page)).paused).toBe(true)
    // Upload order decides which of the two videos is first.
    const position = page.getByRole("dialog").getByText(/^\d+ \/ \d+$/)
    const first = (await position.textContent()) === "1 / 2"
    await page.keyboard.press(first ? "ArrowDown" : "ArrowUp")
    await expect(position, "↑/↓ still change item").toHaveText(first ? "2 / 2" : "1 / 2")
  })

  test("double-click chain seeks +10 then +20 without toggling playback; Escape leaves fullscreen first", async ({
    page,
  }) => {
    await seedVideos(page, "video-nudge")
    await openVideo(page, PORTRAIT)
    await seekTo(page, 5)

    const surface = await box(page, "[data-media-player]")
    const x = surface.x + surface.width * 0.85
    const y = surface.y + surface.height * 0.3
    await page.mouse.dblclick(x, y)
    await expect.poll(async () => (await videoState(page)).time).toBeCloseTo(15, 0)
    await page.mouse.click(x, y)
    await expect.poll(async () => (await videoState(page)).time).toBeCloseTo(25, 0)
    expect((await videoState(page)).paused).toBe(true)
    await expect(player(page).getByText("20s", { exact: true })).toBeVisible()

    const isFullscreen = () => page.evaluate(() => !!document.fullscreenElement?.matches("[data-media-player]"))
    await page.keyboard.press("f")
    await expect.poll(isFullscreen).toBe(true)
    await page.keyboard.press("Escape")
    await expect.poll(isFullscreen).toBe(false)
    await expect(player(page), "Escape left fullscreen, not the gallery").toBeVisible()
  })

  test("speed choice applies and survives reopening the gallery; hover shows a preview bubble", async ({ page }) => {
    await seedVideos(page, "video-speed")
    const ready = hasFfmpeg ? storyboardReady(page) : null
    const sprite = hasFfmpeg ? spriteResponse(page) : null
    await openVideo(page, PORTRAIT)

    await page.getByRole("button", { name: "Playback speed 1×" }).click()
    await page.getByRole("menuitemradio", { name: "1.5×" }).click()
    await expect.poll(async () => (await videoState(page)).rate).toBe(1.5)
    expect((await videoState(page)).paused, "picking a speed is not a click on the video").toBe(true)

    // A menu still animating out owns Escape.
    await expect(page.getByRole("menu")).toBeHidden()
    await page.keyboard.press("Escape")
    await expect(player(page)).toBeHidden()
    await openVideo(page, PORTRAIT)
    await expect.poll(async () => (await videoState(page)).rate).toBe(1.5)
    await expect(page.getByRole("button", { name: "Playback speed 1.5×" })).toBeVisible()

    const bar = await box(page, "[data-media-scrub]")
    await page.mouse.move(bar.x + bar.width * 0.5, bar.y + bar.height / 2)
    const bubble = chrome(page).locator(".bottom-full")
    await expect(bubble).toHaveCSS("opacity", "1")
    await expect(bubble.getByText(/^0:2\d$/)).toBeVisible()
    if (ready && sprite) {
      await ready
      await expectSpriteServed(page, sprite)
      await expect(spriteFrame(page), "the bubble's frame is a sprite tile").toHaveCSS(
        "background-image",
        /\/storyboard\/sprite/
      )
      await expect(bubble.locator("canvas")).toHaveCount(0)

      const y = bar.y + bar.height / 2
      await page.mouse.down()
      await page.mouse.move(bar.x + bar.width * 0.8, y, { steps: 10 })
      await expect(spriteFrame(page), "the sprite frame follows a drag").toBeVisible()
      await expect(bubble).toHaveCSS("opacity", "1")
      await page.mouse.up()
    } else {
      await expect(bubble.locator("canvas")).toBeVisible()
      await expect(bubble.locator("canvas"), "the frame under the pointer arrives").toHaveCSS("opacity", "1")
    }
  })
})

test.describe("Video player — touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test("double tap chains seeks; single tap hides the chrome; scrub swipe doesn't change slide", async ({ page }) => {
    await seedVideos(page, "video-touch")
    const ready = hasFfmpeg ? storyboardReady(page) : null
    const sprite = hasFfmpeg ? spriteResponse(page) : null
    await openVideo(page, PORTRAIT, true)
    await seekTo(page, 5)

    const surface = await box(page, "[data-media-player]")
    const x = surface.x + surface.width * 0.85
    const y = surface.y + surface.height * 0.3
    await page.touchscreen.tap(x, y)
    await page.touchscreen.tap(x, y)
    await expect.poll(async () => (await videoState(page)).time).toBeCloseTo(15, 0)
    await page.touchscreen.tap(x, y)
    await expect.poll(async () => (await videoState(page)).time).toBeCloseTo(25, 0)
    await page.waitForTimeout(800)
    await expect(chrome(page), "a double tap never toggles the chrome").not.toHaveAttribute("inert")

    if (ready && sprite) {
      await ready
      await expectSpriteServed(page, sprite)
    }

    const { src, duration } = await videoState(page)
    const bar = await box(page, "[data-media-scrub]")
    const by = bar.y + bar.height / 2
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: string, px?: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: px === undefined ? [] : [{ x: px, y: by, id: 1 }],
      })
    // Both directions: whichever neighbor exists, a swipe on the bar never reaches it.
    for (const [from, to] of [
      [0.8, 0.2],
      [0.2, 0.8],
    ]) {
      await touch("touchStart", bar.x + bar.width * from)
      for (let i = 1; i <= 12; i++) {
        await touch("touchMove", bar.x + bar.width * (from + ((to - from) * i) / 12))
        await page.waitForTimeout(20)
      }
      if (hasFfmpeg) await expect(spriteFrame(page), "a touch drag shows the sprite frame").toBeVisible()
      await touch("touchEnd")
      await expect.poll(async () => Math.abs((await videoState(page)).time - duration * to) < 1.5).toBe(true)
      await page.waitForTimeout(500)
      expect((await videoState(page)).src, "the swipe scrubbed, it didn't change slide").toBe(src)
      await expect(chrome(page).getByText(PORTRAIT)).toBeVisible()
    }

    // The gradient above the controls is still the video: a tap there toggles the chrome.
    const controls = await box(page, "[data-media-controls]")
    await page.touchscreen.tap(surface.x + surface.width / 2, controls.y - 30)
    await expect(chrome(page)).toHaveAttribute("inert", "")
    await expect(scrub(page)).toBeAttached()

    // Touch plays and pauses from one button in the middle of the video, which comes and goes with the chrome.
    const centre = player(page).locator("button[data-gallery-chrome]")
    const paused = async () => (await videoState(page)).paused
    await seekTo(page, 5)
    await centre.tap()
    await expect.poll(paused).toBe(false)
    await expect(centre, "it leaves with the chrome once the video plays").toHaveAttribute("inert", "")
    await page.touchscreen.tap(surface.x + surface.width / 2, controls.y - 30)
    await expect(centre).toHaveAccessibleName("Pause")
    await expect(centre).not.toHaveAttribute("inert")
    expect(await paused(), "the tap brought the controls up without pausing").toBe(false)
    await centre.tap()
    await expect.poll(paused).toBe(true)
    await expect(centre, "a paused video keeps its controls").toHaveAccessibleName("Play")
    await expect(chrome(page)).not.toHaveAttribute("inert")
  })
})
