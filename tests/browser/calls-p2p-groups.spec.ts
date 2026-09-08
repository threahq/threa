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

async function installCaptureObserver(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    if (!navigator.mediaDevices) return
    const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    Object.defineProperty(window, "__testCallCaptureCount", { value: 0, writable: true })
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await nativeGetUserMedia(constraints)
      ;(window as typeof window & { __testCallCaptureCount: number }).__testCallCaptureCount++
      return stream
    }
  })
}

interface GroupFixture {
  contexts: BrowserContext[]
  pages: Page[]
  memberEmails: string[]
  workspaceId: string
  streamId: string
  testId: string
}

async function addGroupMember(browser: Browser, fixture: GroupFixture, index: number): Promise<Page> {
  const email = `calls-group-${fixture.pages.length + 1}-${index}-${fixture.testId}@example.com`
  const member = await loginInNewContext(browser, email, `Caller ${index}`)
  await member.context.grantPermissions(["microphone", "camera"])
  await installPeerConnectionObserver(member.context)
  await installCaptureObserver(member.context)
  await installDirectOnlyCredentials(member.context)
  await member.page.reload()
  await expectApiOk(
    await member.page.request.post(`/api/dev/workspaces/${fixture.workspaceId}/join`, { data: { role: "member" } }),
    `Join caller ${index} to workspace`
  )
  await expectApiOk(
    await member.page.request.post(`/api/dev/workspaces/${fixture.workspaceId}/streams/${fixture.streamId}/join`),
    `Join caller ${index} to channel`
  )
  await member.page.goto(`/w/${fixture.workspaceId}/s/${fixture.streamId}`)
  await expect(member.page.getByRole("button", { name: "Start a call" })).toBeVisible({ timeout: 40_000 })
  fixture.contexts.push(member.context)
  fixture.pages.push(member.page)
  fixture.memberEmails.push(email)
  return member.page
}

async function setUpGroup(browser: Browser, size: number): Promise<GroupFixture> {
  const testId = generateTestId()
  const ownerContext = await browser.newContext({ permissions: ["microphone", "camera"] })
  await installPeerConnectionObserver(ownerContext)
  await installCaptureObserver(ownerContext)
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
    await installCaptureObserver(member.context)
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
    await expect(page.getByRole("button", { name: "Start a call" })).toBeVisible({ timeout: 40_000 })
  }
  return { contexts, pages, memberEmails, workspaceId, streamId, testId }
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

test("a seventh caller waits without capture while six native P2P sources keep decoding against an unready fake SFU", async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const fixture = await setUpGroup(browser, 6)
  const [owner, ...members] = fixture.pages
  const incumbents = [owner, ...members]
  await members.at(-1)?.setViewportSize({ width: 1280, height: 720 })
  try {
    const startedResponse = owner.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().endsWith("/calls")
    )
    await owner.getByRole("button", { name: "Start a call" }).click()
    await owner.getByRole("menuitem", { name: "Start video call" }).click()
    const started = await startedResponse
    await expectApiOk(started, "Start six-person P2P call")
    const { call } = (await started.json()) as { call: { id: string; workspaceId: string } }
    for (const page of incumbents.slice(1)) {
      const join = page.getByRole("button", { name: "Join", exact: true }).first()
      await expect(join).toBeVisible({ timeout: 20_000 })
      await join.click()
      const admittedCount = incumbents.indexOf(page) + 1
      await expect
        .poll(
          async () => {
            const response = await owner.request.get(`/api/workspaces/${call.workspaceId}/calls/${call.id}`)
            if (!response.ok()) return -1
            return ((await response.json()) as { policy?: { admittedCount?: number } }).policy?.admittedCount ?? -1
          },
          { timeout: 30_000 }
        )
        .toBe(admittedCount)
    }
    await Promise.all(incumbents.map((page) => expect(page.locator(CALL_TILE)).toHaveCount(6, { timeout: 30_000 })))
    await Promise.all(incumbents.slice(1).map((page) => page.getByRole("button", { name: "Turn camera on" }).click()))
    await Promise.all(incumbents.map((page) => expectDecodedMediaOnEveryEdge(page, 5, 60_000)))
    const sourcePeers = await Promise.all(incumbents.map(readMediaEdgeEvidence))
    const entrant = await addGroupMember(browser, fixture, 6)
    const join = entrant.getByRole("button", { name: "Join", exact: true }).first()
    await expect(join).toBeVisible({ timeout: 20_000 })
    const admissionResponse = entrant.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith(`/workspaces/${call.workspaceId}/calls`)
    )
    await join.click()
    const admission = await admissionResponse
    expect(admission.status()).toBe(409)
    expect(await admission.json()).toMatchObject({
      code: "CALL_TRANSPORT_PREPARING",
      details: { callId: call.id, target: "sfu" },
    })
    const before = await Promise.all(incumbents.map(readMediaEdgeEvidence))
    for (const [index, sample] of before.entries()) {
      const sourceIndices = sourcePeers[index].edges.map((edge) => edge.index)
      sample.edges = sample.edges.filter((edge) => sourceIndices.includes(edge.index))
      expect(sample.edges.map((edge) => edge.index)).toEqual(sourceIndices)
    }
    await expect
      .poll(() =>
        entrant.evaluate(
          () => (window as typeof window & { __testCallCaptureCount?: number }).__testCallCaptureCount ?? 0
        )
      )
      .toBe(0)
    await expect(entrant.locator(CALL_TILE)).toHaveCount(0)
    await Promise.all(
      incumbents.map((page, index) => expectMediaProgressOnEveryEdge(page, before[index], "baseline-peers"))
    )

    const snapshot = await owner.request.get(`/api/workspaces/${call.workspaceId}/calls/${call.id}`)
    await expectApiOk(snapshot, "Read automatic transfer snapshot")
    expect(await snapshot.json()).toMatchObject({
      mediaTransport: "p2p",
      policy: { admittedCount: 6 },
      transfer: { phase: "preparing", target: { transport: "sfu" } },
    })
  } finally {
    await Promise.all(fixture.contexts.map((context) => context.close()))
  }
})

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
