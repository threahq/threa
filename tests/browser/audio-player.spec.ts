import { test, expect, type Locator, type Page, type Response } from "@playwright/test"
import { fileURLToPath } from "url"
import { loginAndCreateWorkspaceViaApi, createChannelViaApi, expectApiOk } from "./helpers"

/**
 * The timeline's audio card in a real browser: the session's detached <audio>
 * element, Range requests, pointer and touch scrubbing, and playback that
 * outlives its virtualized row. CI has no ffmpeg, so the upload is marked
 * skipped and the raw WAV plays without a waveform; with ffmpeg it is
 * normalized and the duration is known before the first play. Everything is
 * observed through the card and `navigator.mediaSession`, since the element
 * is never in the DOM. Fixture: a synthetic 12 s 440 Hz sine, 8 kHz mono 8-bit.
 */

test.describe.configure({ timeout: 150_000 })

const TONE = "tone-12s.wav"
const TONE_SECONDS = 12
const fixture = fileURLToPath(new URL(`./fixtures/${TONE}`, import.meta.url))

const cards = (page: Page) => page.locator("[data-audio-player]").filter({ hasText: TONE })
const playButton = (card: Locator) => card.getByRole("button", { name: /^(Play|Pause)$/ })
const seekSlider = (card: Locator) => card.getByRole("slider", { name: "Seek" })
const scrubBar = (card: Locator) => card.locator("[data-media-scrub]")

async function position(card: Locator): Promise<number> {
  return Number(await seekSlider(card).getAttribute("aria-valuenow"))
}

const sessionState = (page: Page) =>
  page.evaluate(() => ({
    playbackState: navigator.mediaSession.playbackState,
    title: navigator.mediaSession.metadata?.title ?? null,
  }))

/** Responses for the attachment's content, followed through any storage redirect. */
function recordContentResponses(page: Page): Response[] {
  const seen: Response[] = []
  page.on("response", (response) => {
    for (let request: ReturnType<Response["request"]> | null = response.request(); request; ) {
      if (/\/attachments\/[^/]+\/content/.test(request.url())) {
        seen.push(response)
        return
      }
      request = request.redirectedFrom()
    }
  })
  return seen
}

async function openNewChannel(page: Page, prefix: string) {
  const { testId, workspaceId } = await loginAndCreateWorkspaceViaApi(page, prefix)
  const streamId = await createChannelViaApi(page, workspaceId, `${prefix}-${testId}`, "public")
  await page.goto(`/w/${workspaceId}/s/${streamId}`)
  await expect(page.locator("[data-message-composer-root]").first()).toBeVisible({ timeout: 60_000 })
  return { testId, workspaceId, streamId }
}

async function sendTone(page: Page): Promise<void> {
  const before = await cards(page).count()
  const root = page.locator("[data-message-composer-root]").first()
  await root.locator('input[type="file"][multiple]').setInputFiles([fixture])
  const send = root.getByRole("button", { name: "Send", exact: true })
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await send.click()
  await expect(cards(page)).toHaveCount(before + 1, { timeout: 30_000 })
}

async function ready(card: Locator): Promise<void> {
  // The optimistic row's content remounts when the server copy replaces it, which drops a gesture in flight.
  await expect(card.page().locator('[data-message-id^="temp_"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(playButton(card), "processing holds the play button disabled").toBeEnabled({ timeout: 60_000 })
}

async function play(card: Locator): Promise<void> {
  await playButton(card).click()
  await expect(playButton(card)).toHaveAccessibleName("Pause")
}

async function clickBar(page: Page, card: Locator, fraction: number): Promise<void> {
  const bar = await scrubBar(card).boundingBox()
  if (!bar) throw new Error("no scrub bar box")
  await page.mouse.click(bar.x + bar.width * fraction, bar.y + bar.height / 2)
}

async function pickSpeed(page: Page, card: Locator, from: string, to: string): Promise<void> {
  await card.getByRole("button", { name: `Playback speed ${from}` }).click()
  await page.getByRole("menuitemradio", { name: to }).click()
  // A menu still animating out owns pointer events and Escape.
  await expect(page.getByRole("menu")).toBeHidden()
  await expect(card.getByRole("button", { name: `Playback speed ${to}` })).toBeVisible()
}

/** Seconds of track advanced per wall-clock second over `ms`. */
async function advanceRate(page: Page, card: Locator, ms: number): Promise<number> {
  const t0 = await position(card)
  const started = Date.now()
  await page.waitForTimeout(ms)
  const t1 = await position(card)
  return (t1 - t0) / ((Date.now() - started) / 1000)
}

test.describe("Audio player — desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("plays over Range requests, seeks, changes speed, downloads either file, and an idle click starts there", async ({
    page,
  }) => {
    const content = recordContentResponses(page)
    await openNewChannel(page, "audio-desk")
    await sendTone(page)
    const card = cards(page).first()
    await ready(card)

    await play(card)
    await expect.poll(() => position(card)).toBeGreaterThan(0.5)
    await expect(card.getByText(/^0:0[1-9] \/ 0:1[12]$/), "time text follows playback").toBeVisible()
    expect(await sessionState(page)).toEqual({ playbackState: "playing", title: TONE })
    expect(
      content.map((r) => r.status()),
      "the content request honors Range"
    ).toContain(206)

    await clickBar(page, card, 0.25)
    await expect.poll(() => position(card)).toBeGreaterThan(TONE_SECONDS * 0.25 - 0.5)
    expect(await position(card)).toBeLessThan(TONE_SECONDS * 0.25 + 1.5)

    await pickSpeed(page, card, "1×", "2×")
    await expect(playButton(card), "picking a speed doesn't pause").toHaveAccessibleName("Pause")
    expect(await advanceRate(page, card, 1_500), "2× advances twice as fast as the clock").toBeGreaterThan(1.6)

    await clickBar(page, card, 0.75)
    await expect.poll(() => position(card)).toBeGreaterThan(TONE_SECONDS * 0.75 - 0.5)
    await playButton(card).click()
    await expect(playButton(card)).toHaveAccessibleName("Play")
    await expect.poll(async () => (await sessionState(page)).playbackState).toBe("paused")

    const downloadVia = async (item: string) => {
      await card.getByRole("button", { name: `Download ${TONE}` }).click()
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("menuitem", { name: item }).click(),
      ])
      return download.suggestedFilename()
    }
    expect(await downloadVia("Download original"), "the original is saved, not navigated to").toBe(TONE)
    expect(await downloadVia("Download processed"), "the processed file is the normalized one").toBe(
      TONE.replace(/\.wav$/, ".m4a")
    )

    // A reload leaves the card idle; only a known duration lets the idle slider pick a start.
    await page.reload()
    const idle = cards(page).first()
    await ready(idle)
    await expect(playButton(idle)).toHaveAccessibleName("Play")
    const idleSeekable = (await scrubBar(idle).getAttribute("data-disabled")) === null
    if (idleSeekable) {
      await clickBar(page, idle, 0.5)
      await expect(playButton(idle), "an idle click starts playback").toHaveAccessibleName("Pause")
      await expect.poll(() => position(idle)).toBeGreaterThan(TONE_SECONDS * 0.5 - 0.5)
      expect(await position(idle)).toBeLessThan(TONE_SECONDS * 0.5 + 2.5)
      await expect(idle.getByRole("button", { name: "Playback speed 2×" }), "the speed choice persists").toBeVisible()
    } else {
      await expect(
        idle.getByText("0:00 / 0:00"),
        "without a known duration the idle card has nothing to seek"
      ).toBeVisible()
    }
  })

  test("keeps playing while scrolled out of the timeline and stops on leaving the stream", async ({ page }) => {
    const { testId, workspaceId, streamId } = await openNewChannel(page, "audio-scroll")
    const otherId = await createChannelViaApi(page, workspaceId, `audio-other-${testId}`, "public")
    await sendTone(page)
    await ready(cards(page).first())
    for (let n = 1; n <= 60; n++) {
      await expectApiOk(
        await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
          data: { streamId, content: `[${testId}] filler ${String(n).padStart(2, "0")}\n\nsecond line\n\nthird line` },
        }),
        `Send filler ${n}`
      )
    }
    // After a reload the audio message is outside the bootstrap window and comes back from an older page.
    await page.reload()
    const scroller = page.locator(`[data-stream-scroller="${streamId}"]`)
    await expect(scroller.getByText(`[${testId}] filler 60`)).toBeVisible({ timeout: 60_000 })
    await expect(cards(page), "the audio message starts outside the virtualized window").toHaveCount(0)

    const scrollUntilCard = async () => {
      await expect(async () => {
        await scroller.evaluate((el) => el.scrollBy(0, -800))
        await expect(cards(page)).toHaveCount(1, { timeout: 500 })
      }).toPass({ timeout: 20_000 })
      await cards(page).first().scrollIntoViewIfNeeded()
    }

    await scrollUntilCard()
    const card = cards(page).first()
    await ready(card)
    // Half speed leaves room on the 12 s tone for the scroll round trip.
    await pickSpeed(page, card, "1×", "0.5×")
    await play(card)
    await expect.poll(() => position(card)).toBeGreaterThan(0.2)
    const before = await position(card)

    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(cards(page), "the row left the virtualized window").toHaveCount(0)
    await page.waitForTimeout(1_500)
    expect((await sessionState(page)).playbackState, "the unmounted card's audio keeps playing").toBe("playing")

    await scrollUntilCard()
    await expect(playButton(cards(page).first()), "the remounted card shows the live session").toHaveAccessibleName(
      "Pause"
    )
    expect(await position(cards(page).first())).toBeGreaterThan(before + 0.5)

    await page.locator(`a[href="/w/${workspaceId}/s/${otherId}"]`).first().click()
    await expect(page).toHaveURL(new RegExp(`/s/${otherId}$`))
    await expect.poll(sessionState.bind(null, page), { message: "leaving the stream stops playback" }).toEqual({
      playbackState: "none",
      title: null,
    })
  })
  test("plays in the attachment explorer's preview, downloads the original from it, and stops when it closes", async ({
    page,
  }) => {
    const { workspaceId, streamId } = await openNewChannel(page, "audio-files")
    await sendTone(page)
    await ready(cards(page).first())

    await page.goto(`/w/${workspaceId}/s/${streamId}?explorer&streams=${streamId}`)
    const explorer = page.getByRole("dialog", { name: "Files" })
    await explorer.getByRole("button", { name: TONE }).first().click({ timeout: 60_000 })
    const preview = explorer.locator("[data-audio-player]")
    await play(preview)
    await expect.poll(() => position(preview)).toBeGreaterThan(0.5)
    await expect(playButton(preview), "the preview follows the playing track").toHaveAccessibleName("Pause")

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      explorer.getByRole("button", { name: "Download", exact: true }).click(),
    ])
    expect(download.suggestedFilename(), "the explorer's download saves the original").toBe(TONE)

    await page.keyboard.press("Escape")
    await expect(explorer).toBeHidden()
    await expect
      .poll(async () => (await sessionState(page)).playbackState, "closing the explorer stops it")
      .toBe("none")
  })
})

test.describe("Audio player — touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test("tap plays and a touch drag on the waveform scrubs", async ({ page }) => {
    await openNewChannel(page, "audio-touch")
    await sendTone(page)
    const card = cards(page).first()
    await ready(card)

    await playButton(card).tap()
    await expect(playButton(card)).toHaveAccessibleName("Pause")
    await expect.poll(() => position(card)).toBeGreaterThan(0.3)

    const bar = await scrubBar(card).boundingBox()
    if (!bar) throw new Error("no scrub bar box")
    const y = bar.y + bar.height / 2
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: string, fraction?: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: fraction === undefined ? [] : [{ x: bar.x + bar.width * fraction, y, id: 1 }],
      })
    await touch("touchStart", 0.2)
    for (let i = 1; i <= 12; i++) {
      await touch("touchMove", 0.2 + (0.5 * i) / 12)
      await page.waitForTimeout(20)
    }
    await touch("touchEnd")
    await expect.poll(() => position(card)).toBeGreaterThan(TONE_SECONDS * 0.7 - 0.5)
    expect(await position(card)).toBeLessThan(TONE_SECONDS * 0.7 + 2.5)
    await expect(playButton(card), "release keeps playing").toHaveAccessibleName("Pause")
  })
})
