import { test, expect, type Page, type TestInfo } from "@playwright/test"
import { ulid } from "ulid"
import { createChannel, expectApiOk, loginAndCreateWorkspace, workspaceIdFromUrl } from "./helpers"
import { runTestSql } from "./global-setup"

const IMAGE_URLS = ["https://gallery.example.test/first.png", "https://gallery.example.test/second.png"]
const IMAGE_NAMES = ["First linked image", "Second linked image"]

async function makeImage(page: Page, label: string, color: string): Promise<Buffer> {
  const data = await page.evaluate(
    ({ label, color }) => {
      const canvas = document.createElement("canvas")
      canvas.width = 960
      canvas.height = 640
      const context = canvas.getContext("2d")!
      context.fillStyle = color
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = "white"
      context.font = "48px sans-serif"
      context.fillText(label, 64, 320)
      return canvas.toDataURL("image/png").split(",")[1]
    },
    { label, color }
  )
  return Buffer.from(data, "base64")
}

async function seedMessage(page: Page, withAttachment: boolean): Promise<{ workspaceId: string; messageId: string }> {
  const { testId } = await loginAndCreateWorkspace(page, "linked-images")
  await createChannel(page, `gallery-${testId}`)
  const workspaceId = workspaceIdFromUrl(page)
  const streamId = new URL(page.url()).pathname.match(/\/s\/([^/]+)/)![1]

  for (const [index, url] of IMAGE_URLS.entries()) {
    const image = await makeImage(page, IMAGE_NAMES[index], index === 0 ? "#225c72" : "#76502e")
    await page.route(url, (route) => route.fulfill({ contentType: "image/png", body: image }))
    // Seed the metadata cache; extraction, message delivery and rendering use their real paths.
    runTestSql(`
      INSERT INTO link_previews
        (id, workspace_id, url, normalized_url, title, content_type, status, fetched_at, expires_at)
      VALUES
        ('lp_${ulid()}', '${workspaceId}', '${url}', '${url}', '${IMAGE_NAMES[index]}',
         'image', 'completed', NOW(), NOW() + INTERVAL '1 day')
    `)
  }

  const attachmentIds: string[] = []
  if (withAttachment) {
    const image = await makeImage(page, "Uploaded image", "#50466e")
    const response = await page.request.post(`/api/workspaces/${workspaceId}/attachments`, {
      multipart: { file: { name: "uploaded-image.png", mimeType: "image/png", buffer: image } },
    })
    await expectApiOk(response, "Upload gallery fixture")
    const body = await response.json()
    attachmentIds.push(body.attachment.id)
  }

  const response = await page.request.post(`/api/workspaces/${workspaceId}/messages`, {
    data: {
      streamId,
      content: `Gallery examples: [First image](${IMAGE_URLS[0]}) and [Second image](${IMAGE_URLS[1]})`,
      attachmentIds,
    },
  })
  await expectApiOk(response, "Send gallery fixture")
  const { message } = await response.json()
  await expect(page.getByRole("button", { name: "Open image preview: Second linked image" })).toBeVisible({
    timeout: 30_000,
  })
  return { workspaceId, messageId: message.id }
}

async function swipeRight(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 70, y: 400, id: 0 }],
    })
    for (let x = 90; x <= 330; x += 20) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 400, id: 0 }] })
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } finally {
    await cdp.detach()
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: "image/png" })
}

async function expectCenteredImage(page: Page, name: string): Promise<void> {
  const image = page.locator("[data-media-gallery]").getByRole("img", { name, exact: true })
  await expect
    .poll(async () => {
      const bounds = await image.boundingBox()
      return bounds ? Math.abs(bounds.x + bounds.width / 2 - page.viewportSize()!.width / 2) : Infinity
    })
    .toBeLessThan(1)
}

for (const mobile of [false, true]) {
  test.describe(mobile ? "Phone linked images" : "Desktop linked images", () => {
    test.use({ viewport: { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile })
    test.describe.configure({ timeout: 120_000 })

    if (mobile) {
      test("should keep the viewed image centered when an earlier link is removed", async ({ page }) => {
        const { workspaceId, messageId } = await seedMessage(page, true)
        await page.setViewportSize({ width: 390, height: 844 })
        const messageUrl = page.url()
        const gallery = page.locator("[data-media-gallery]")

        await page.getByRole("button", { name: "Open image preview: Second linked image" }).tap()
        await expect(page.locator("html")).toHaveAttribute("data-input", "touch")
        await expect(gallery.getByText("3 / 3", { exact: true })).toBeVisible()
        await expectApiOk(
          await page.request.patch(`/api/workspaces/${workspaceId}/messages/${messageId}`, {
            data: { content: `Gallery examples: [Second image](${IMAGE_URLS[1]})` },
          }),
          "Remove earlier linked image"
        )
        await expect(gallery.getByText("2 / 2", { exact: true })).toBeVisible({ timeout: 30_000 })
        await expect
          .poll(() =>
            page.evaluate((src) => {
              const target = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
              return target instanceof HTMLImageElement && target.src === src
            }, IMAGE_URLS[1])
          )
          .toBe(true)

        await page.goBack()
        await expect(gallery).toBeHidden()
        await expect(page).toHaveURL(messageUrl)
      })
    }

    for (const withAttachment of [false, true]) {
      test(`should browse ${withAttachment ? "uploads and linked images" : "linked images without uploads"} and close with Back`, async ({
        page,
      }, testInfo) => {
        await seedMessage(page, withAttachment)
        if (mobile) await page.setViewportSize({ width: 390, height: 844 })
        const messageUrl = page.url()
        const gallery = page.locator("[data-media-gallery]")
        const total = withAttachment ? 3 : 2

        const secondPreview = page.getByRole("button", { name: "Open image preview: Second linked image" })
        if (mobile) await secondPreview.tap()
        else await secondPreview.click()
        if (mobile) await expect(page.locator("html")).toHaveAttribute("data-input", "touch")
        await expect(gallery).toBeVisible()
        await expect(gallery.getByText(`${total} / ${total}`, { exact: true })).toBeVisible()
        await expect(page).toHaveURL(/[?&]media=/)
        await expect(gallery.locator(`img[src="${IMAGE_URLS[1]}"]:not([aria-hidden])`).first()).toBeVisible()
        await capture(page, testInfo, mobile ? "phone-linked-image" : "desktop-linked-image")

        if (mobile) await swipeRight(page)
        else await page.keyboard.press("ArrowLeft")
        await expect(gallery.getByText(`${total - 1} / ${total}`, { exact: true })).toBeVisible()
        if (mobile) await expectCenteredImage(page, IMAGE_NAMES[0])

        if (withAttachment) {
          if (mobile) await swipeRight(page)
          else await gallery.getByRole("button", { name: "Previous", exact: true }).click()
          await expect(gallery.getByText(`1 / ${total}`, { exact: true })).toBeVisible()
          if (mobile) await expectCenteredImage(page, "uploaded-image.png")
          await expect(gallery.getByRole("button", { name: "Download", exact: true })).toBeVisible()
          await capture(page, testInfo, mobile ? "phone-upload-in-shared-gallery" : "desktop-upload-in-shared-gallery")
        }

        await page.goBack()
        await expect(gallery).toBeHidden()
        await expect(page).toHaveURL(messageUrl)

        const firstPreview = page.getByRole("button", { name: "Open image preview: First linked image" })
        if (mobile) await firstPreview.tap()
        else await firstPreview.click()
        await expect(gallery.getByText(`${withAttachment ? 2 : 1} / ${total}`, { exact: true })).toBeVisible()
        if (mobile) await gallery.getByRole("button", { name: "Close", exact: true }).tap()
        else await page.keyboard.press("Escape")
        await expect(gallery).toBeHidden()
        await expect(page).toHaveURL(messageUrl)

        if (withAttachment) {
          const uploadedImage = page.getByRole("button", { name: "uploaded-image.png", exact: true })
          if (mobile) await uploadedImage.tap()
          else await uploadedImage.click()
          await expect(gallery.getByText("1 / 3", { exact: true })).toBeVisible()
          if (mobile) {
            await page.goBack()
          } else {
            await gallery.getByRole("button", { name: "View Second linked image", exact: true }).click()
            await expect(gallery.getByText("3 / 3", { exact: true })).toBeVisible()
            await page.goBack()
          }
          await expect(gallery).toBeHidden()
          await expect(page).toHaveURL(messageUrl)
        }
      })
    }
  })
}
