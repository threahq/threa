import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"
import {
  expectDecodedMediaOnEveryEdge,
  installDirectOnlyCredentials,
  installPeerConnectionObserver,
  readMediaEdgeEvidence,
  expectMediaProgressOnEveryEdge,
} from "./calls-media-evidence"
import { expectApiOk, generateTestId, loginAndCreateWorkspace, loginInNewContext } from "./helpers"
import { CAMERA_PUBLISH_LADDER } from "../../apps/frontend/src/calls/config"

const CALL_TILE = "[data-testid='call-tile']"

interface GroupFixture {
  contexts: BrowserContext[]
  pages: Page[]
  memberEmails: string[]
}

async function setUpGroup(browser: Browser, size: number): Promise<GroupFixture> {
  const testId = generateTestId()
  const ownerContext = await browser.newContext({ permissions: ["microphone", "camera"] })
  await installPeerConnectionObserver(ownerContext)
  await installDirectOnlyCredentials(ownerContext)
  const ownerPage = await ownerContext.newPage()
  await loginAndCreateWorkspace(ownerPage, `calls-group-${size}`)
  const workspaceId = ownerPage.url().match(/\/w\/([^/]+)/)?.[1]
  if (!workspaceId) throw new Error("Could not resolve group workspace")

  const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT
  if (!backendPort) throw new Error("PLAYWRIGHT_BACKEND_PORT is required for P2P enrollment")
  const internalApiKey = process.env.PLAYWRIGHT_INTERNAL_API_KEY
  if (!internalApiKey) throw new Error("PLAYWRIGHT_INTERNAL_API_KEY is required for P2P enrollment")
  await expectApiOk(
    await ownerPage.request.post(`http://localhost:${backendPort}/internal/feature-flags`, {
      headers: { "x-internal-api-key": internalApiKey },
      data: { workspaceId, subjectType: "workspace", subjectId: workspaceId, overrides: { callsP2p: "on" } },
    }),
    "Enroll group workspace in callsP2p"
  )
  const streamResponse = await ownerPage.request.post(`/api/workspaces/${workspaceId}/streams`, {
    data: { type: "channel", slug: `p2p-group-${size}-${testId}`, visibility: "public" },
  })
  await expectApiOk(streamResponse, "Create group call channel")
  const streamId = ((await streamResponse.json()) as { stream: { id: string } }).stream.id

  const contexts = [ownerContext]
  const pages = [ownerPage]
  const memberEmails: string[] = []
  for (let index = 1; index < size; index++) {
    const email = `calls-group-${size}-${index}-${testId}@example.com`
    memberEmails.push(email)
    const member = await loginInNewContext(browser, email, `Caller ${index}`)
    await member.context.grantPermissions(["microphone", "camera"])
    if (size === 6 && index === size - 1) await member.page.setViewportSize({ width: 390, height: 844 })
    await installPeerConnectionObserver(member.context)
    await installDirectOnlyCredentials(member.context)
    await member.page.reload()
    await expectApiOk(
      await member.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, { data: { role: "member" } }),
      `Join caller ${index} to workspace`
    )
    await expectApiOk(
      await member.page.request.post(`/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`),
      `Join caller ${index} to channel`
    )
    contexts.push(member.context)
    pages.push(member.page)
  }
  for (const page of pages) {
    await page.goto(`/w/${workspaceId}/s/${streamId}`)
    await expect(page.getByRole("button", { name: "Start a call" })).toBeVisible({ timeout: 20_000 })
  }
  return { contexts, pages, memberEmails }
}

async function expectCameraBudget(pages: Page[]): Promise<void> {
  await Promise.all(
    pages.map((page) =>
      expect
        .poll(
          () =>
            page.evaluate((budget) => {
              const peers = (
                (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] })
                  .__testCallPeerConnections ?? []
              ).filter((peer) => peer.connectionState !== "closed")
              const caps = peers.flatMap((peer) =>
                peer
                  .getSenders()
                  .filter(({ track }) => track?.kind === "video")
                  .flatMap((sender) => sender.getParameters().encodings.map(({ maxBitrate }) => maxBitrate))
              )
              return (
                caps.length === peers.length &&
                caps.every((cap) => typeof cap === "number" && cap > 0) &&
                caps.reduce<number>((sum, cap) => sum + (cap ?? 0), 0) <= budget
              )
            }, CAMERA_PUBLISH_LADDER[0].maxBitrate),
          { timeout: 10_000 }
        )
        .toBe(true)
    )
  )
}

for (const size of [3, 6]) {
  test(`direct-only ${size}-person P2P mesh keeps decoded media on every edge through group churn`, async ({
    browser,
  }) => {
    test.setTimeout(size === 6 ? 300_000 : 180_000)
    const fixture = await setUpGroup(browser, size)
    const [owner, ...members] = fixture.pages
    try {
      await owner.getByRole("button", { name: "Start a call" }).click()
      await owner.getByRole("menuitem", { name: "Start video call" }).click()
      await expect(owner.locator(CALL_TILE)).toHaveCount(1, { timeout: 20_000 })
      await Promise.all(
        members.map(async (page) => {
          const join = page.getByRole("button", { name: "Join", exact: true }).first()
          await expect(join).toBeVisible({ timeout: 20_000 })
          await join.click()
        })
      )
      if (size === 6) {
        const mobile = members[members.length - 1]
        const handle = mobile.getByTestId("call-drawer-handle")
        await expect(handle).toBeVisible({ timeout: 20_000 })
        const box = await handle.boundingBox()
        if (!box) throw new Error("Mobile call resize handle has no bounds")
        await mobile.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await mobile.mouse.down()
        await mobile.mouse.move(box.x + box.width / 2, 830, { steps: 12 })
        await mobile.mouse.up()
        await expect(mobile.getByTestId("mobile-call-drawer")).toHaveAttribute("data-mode", "full")
        await mobile.getByLabel("Grid", { exact: true }).click()
      }
      await Promise.all(
        fixture.pages.map((page) => expect(page.locator(CALL_TILE)).toHaveCount(size, { timeout: 30_000 }))
      )
      await Promise.all(
        fixture.pages.map((page) =>
          expect
            .poll(
              () =>
                page.evaluate(
                  (expected) =>
                    (
                      (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] })
                        .__testCallPeerConnections ?? []
                    ).filter((peer) => peer.connectionState !== "closed").length === expected &&
                    (
                      (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] })
                        .__testCallPeerConnections ?? []
                    )
                      .filter((peer) => peer.connectionState !== "closed")
                      .every((peer) => peer.connectionState === "connected"),
                  size - 1
                ),
              { timeout: 30_000 }
            )
            .toBe(true)
        )
      )
      await Promise.all(members.map((page) => page.getByRole("button", { name: "Turn camera on" }).click()))
      await Promise.all(fixture.pages.map((page) => expectDecodedMediaOnEveryEdge(page, size - 1)))
      await expectCameraBudget(fixture.pages)
      await owner.getByLabel("Connection diagnostics").click()
      const connections = owner.getByRole("list", { name: "Peer connections" })
      await expect(connections.getByRole("listitem")).toHaveCount(size - 1)
      for (const email of fixture.memberEmails) await expect(connections).toContainText(email)
      await expect(owner.getByText("Unclassified data", { exact: true })).toBeVisible()
      await owner.getByLabel("Connection diagnostics").click()
      const beforeCameraReplace = await Promise.all(members.map(readMediaEdgeEvidence))
      await owner.getByRole("button", { name: "Turn camera off" }).click()
      await owner.getByRole("button", { name: "Turn camera on" }).click()
      await Promise.all(members.map((page, index) => expectMediaProgressOnEveryEdge(page, beforeCameraReplace[index])))
      await Promise.all(fixture.pages.map((page) => expectDecodedMediaOnEveryEdge(page, size - 1)))
      const leaving = members.slice(0, size === 6 ? 2 : 1)
      await Promise.all(leaving.map((page) => page.getByRole("button", { name: "Leave call" }).click()))
      const remaining = fixture.pages.filter((page) => !leaving.includes(page))
      await Promise.all(
        remaining.map((page) => expect(page.locator(CALL_TILE)).toHaveCount(remaining.length, { timeout: 30_000 }))
      )
      await Promise.all(remaining.map((page) => expectDecodedMediaOnEveryEdge(page, remaining.length - 1)))
      await expectCameraBudget(remaining)
    } catch (error) {
      await test.info().attach("group-media-evidence", {
        body: JSON.stringify(await Promise.allSettled(fixture.pages.map(readMediaEdgeEvidence)), null, 2),
        contentType: "application/json",
      })
      throw error
    } finally {
      await Promise.all(fixture.contexts.map((context) => context.close()))
    }
  })
}
