import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk, createDmDraftId, generateTestId } from "./helpers"

/**
 * Two-context 1:1 DM call e2e (plan §Rollout M1 exit gate, PR 1.5). Real browser
 * A + real browser B against the dev-test stack with the fake Cloudflare seam
 * (negotiationless — see tests/browser/fake-cf-runner.ts): the media plane
 * forwards nothing, so every assertion is on the CONTROL plane (roster / dock /
 * ring / timeline card via the `/calls` socket + outbox), never getStats bytes.
 *
 * Fake media (`--use-fake-device-for-media-stream` + auto-accepted permission,
 * wired in playwright.config.ts's `calls` project) lets getUserMedia resolve and
 * the call reach the connected phase headless without a real device.
 *
 * Grace + sweep run low in this stack (CALL_EMPTY_GRACE_MS / CALL_SWEEP_INTERVAL_MS)
 * so an emptied call reaches `ended` — and its timeline card flips — inside the
 * test window.
 */

const CALL_TILE = "[data-testid='call-tile']"

interface DmPair {
  ownerContext: BrowserContext
  ownerPage: Page
  inviteeContext: BrowserContext
  inviteePage: Page
  workspaceId: string
  dmStreamId: string
  inviteeUserId: string
  /** A's credentials, so a test can log the SAME user in on a second "device". */
  ownerEmail: string
  ownerName: string
}

/** A owner + B member sharing a real DM stream, both viewing it, calls enabled. */
async function setUpDmPair(browser: Browser, options: { p2p?: boolean } = {}): Promise<DmPair> {
  const testId = generateTestId()
  const inviteeEmail = `calls-b-${testId}@example.com`
  const inviteeName = `Calls B ${testId}`

  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  const invitee = await loginInNewContext(browser, inviteeEmail, inviteeName)

  if (options.p2p) {
    const observePeerConnections = () => {
      const NativePeerConnection = window.RTCPeerConnection
      const peers: RTCPeerConnection[] = []
      Object.defineProperty(window, "__testCallPeerConnections", { value: peers })
      window.RTCPeerConnection = new Proxy(NativePeerConnection, {
        construct(Target, args) {
          const peer = new Target(...(args as ConstructorParameters<typeof RTCPeerConnection>))
          peers.push(peer)
          return peer
        },
      })
    }
    await ownerContext.addInitScript(observePeerConnections)
    await invitee.context.addInitScript(observePeerConnections)
    await invitee.page.reload()
    const directOnlyCredentials = (route: import("@playwright/test").Route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ iceServers: [], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
      })
    await ownerContext.route("**/turn-credentials", directOnlyCredentials)
    await invitee.context.route("**/turn-credentials", directOnlyCredentials)
  }

  const owner = await loginAndCreateWorkspace(ownerPage, "calls-a")
  const workspaceId = ownerPage.url().match(/\/w\/([^/]+)/)?.[1]
  if (!workspaceId) throw new Error("Could not resolve workspaceId from owner URL")

  if (options.p2p) {
    const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT
    if (!backendPort) throw new Error("PLAYWRIGHT_BACKEND_PORT is required for P2P enrollment")
    const internalApiKey = process.env.PLAYWRIGHT_INTERNAL_API_KEY
    if (!internalApiKey) throw new Error("PLAYWRIGHT_INTERNAL_API_KEY is required for P2P enrollment")
    const enrolled = await ownerPage.request.post(`http://localhost:${backendPort}/internal/feature-flags`, {
      headers: { "x-internal-api-key": internalApiKey },
      data: { workspaceId, subjectType: "workspace", subjectId: workspaceId, overrides: { callsP2p: "on" } },
    })
    await expectApiOk(enrolled, "Enroll workspace in callsP2p")
    await ownerPage.reload()
  }

  // Calls are governed by the `calls` feature flag (workspace scope, default on).
  // The flag is control-plane-written only — there is no regional enable path to
  // hit from an e2e — but default-on means every workspace has calls unless a
  // backoffice `off` override is set, which nothing here does. So no enable step;
  // the dev-test stack's fake-CF seam satisfies the env gate.

  // B joins the workspace as a member.
  await expectApiOk(
    await invitee.page.request.post(`/api/dev/workspaces/${workspaceId}/join`, {
      data: { role: "member", name: inviteeName },
    }),
    "Invitee joins workspace"
  )

  // Resolve B's user id, then materialize the DM by sending the first message from A.
  const usersBody = (await ownerPage.request.get(`/api/workspaces/${workspaceId}/users`).then((r) => r.json())) as {
    users: Array<{ id: string; name: string }>
  }
  const inviteeUserId = usersBody.users.find((u) => u.name === inviteeName)?.id
  if (!inviteeUserId) throw new Error("Invitee user not found in workspace")

  await ownerPage.goto(`/w/${workspaceId}/s/${createDmDraftId(inviteeUserId)}`)
  await ownerPage.locator("[contenteditable='true']").first().click()
  await ownerPage.keyboard.type(`DM open ${testId}`)
  await ownerPage.getByRole("button", { name: "Send" }).click()
  await expect(ownerPage).toHaveURL(new RegExp(`/w/${workspaceId}/s/stream_`), { timeout: 15000 })
  const dmStreamId = ownerPage.url().match(/\/s\/([^/?]+)/)?.[1]
  if (!dmStreamId) throw new Error("DM stream id not resolved after first message")

  // Reload A onto the freshly-materialized DM stream, and land B on the same DM
  // so both see the timeline card. (The header call button is on by default via
  // the `calls` flag, so no bootstrap round-trip is needed to reveal it.)
  await ownerPage.reload()
  await invitee.page.goto(`/w/${workspaceId}/s/${dmStreamId}`)

  // The call button proves A's bootstrap has calls on; the composer proves B is in.
  await expect(ownerPage.getByRole("button", { name: "Start a call" })).toBeVisible({ timeout: 15000 })
  await expect(invitee.page.locator("[contenteditable='true']").first()).toBeVisible({ timeout: 15000 })

  return {
    ownerContext,
    ownerPage,
    inviteeContext: invitee.context,
    inviteePage: invitee.page,
    workspaceId,
    dmStreamId,
    inviteeUserId,
    ownerEmail: owner.email,
    ownerName: owner.name,
  }
}

async function startCallFromHeader(page: Page): Promise<void> {
  // The header call button is a menu (Start voice call / Start video call); open it
  // and pick the mic-only voice start.
  await page.getByRole("button", { name: "Start a call" }).click()
  await page.getByRole("menuitem", { name: "Start voice call" }).click()
  // The dock renders once the connected phase lands — self tile present.
  await expect(page.locator(CALL_TILE)).toHaveCount(1, { timeout: 20000 })
}

test.describe("1:1 DM calls", () => {
  test("direct-only opted-in peers exchange decoded P2P media, controls, reconnect, and hang up", async ({
    browser,
  }) => {
    test.setTimeout(80000)
    const pair = await setUpDmPair(browser, { p2p: true })
    const { ownerPage: a, inviteePage: b, workspaceId, dmStreamId } = pair
    try {
      const startedResponse = a.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith(`/workspaces/${workspaceId}/calls`)
      )
      await a.getByRole("button", { name: "Start a call" }).click()
      await a.getByRole("menuitem", { name: "Start video call" }).click()
      const started = await startedResponse
      await expectApiOk(started, "Start video call")
      const callId = (await started.json()).call.id as string
      const readSelf = async () => {
        const response = await b.request.get(
          new URL(`/api/workspaces/${workspaceId}/calls/${callId}`, b.url()).toString()
        )
        await expectApiOk(response, "Read current call endpoint")
        return (await response.json()).self as { endpointId: string; mediaIncarnation: string }
      }
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      await expect(a.getByRole("button", { name: "Turn camera off" })).toBeVisible()
      await b.getByRole("button", { name: "Turn camera on" }).click()
      const playableVideos = (page: Page) =>
        page.locator(`${CALL_TILE} video`).evaluateAll(
          (nodes) =>
            nodes.filter((node) => {
              const video = node as HTMLVideoElement
              const stream = video.srcObject as MediaStream | null
              return !!stream?.getVideoTracks().some((track) => track.readyState === "live")
            }).length
        )
      const inboundMedia = (page: Page) =>
        page.evaluate(async () => {
          const peers = (
            (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ??
            []
          ).filter((peer) => peer.connectionState !== "closed")
          let audioBytes = 0
          let audioEnergy = 0
          let videoBytes = 0
          let videoFrames = 0
          for (const peer of peers) {
            const stats = await peer.getStats()
            stats.forEach((report) => {
              if (report.type !== "inbound-rtp") return
              if (report.kind === "audio" || report.mediaType === "audio") {
                audioBytes += report.bytesReceived ?? 0
                audioEnergy += report.totalAudioEnergy ?? 0
              }
              if (report.kind === "video" || report.mediaType === "video") {
                videoBytes += report.bytesReceived ?? 0
                videoFrames += report.framesDecoded ?? 0
              }
            })
          }
          return { audioBytes, audioEnergy, videoBytes, videoFrames }
        })
      const decodedAudioFlow = (page: Page) =>
        page.evaluate(async () => {
          const outputReady = [...document.querySelectorAll("body > audio")].some((node) => {
            const audio = node as HTMLAudioElement
            return (
              !audio.paused &&
              audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              !!(audio.srcObject as MediaStream | null)
                ?.getAudioTracks()
                .some((track) => track.readyState === "live" && !track.muted)
            )
          })
          const peers =
            (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ??
            []
          let inboundAudioBytes = 0
          const inboundVideoTrackIds = new Set(
            peers.flatMap((peer) =>
              peer
                .getReceivers()
                .filter((receiver) => receiver.track.kind === "video")
                .map((receiver) => receiver.track.id)
            )
          )
          let decodedVideo = false
          for (const peer of peers) {
            const stats = await peer.getStats()
            stats.forEach((report) => {
              if (report.type !== "inbound-rtp") return
              if (report.kind === "audio" || report.mediaType === "audio")
                inboundAudioBytes += report.bytesReceived ?? 0
              if (
                (report.kind === "video" || report.mediaType === "video") &&
                report.bytesReceived > 0 &&
                report.framesDecoded > 0
              )
                decodedVideo = true
            })
          }
          const renderedVideo = [...document.querySelectorAll(`[data-testid='call-tile'] video`)].some((node) => {
            const video = node as HTMLVideoElement
            const stream = video.srcObject as MediaStream | null
            return (
              video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              video.videoWidth > 0 &&
              video.videoHeight > 0 &&
              !!stream?.getVideoTracks().some((track) => inboundVideoTrackIds.has(track.id))
            )
          })
          return outputReady && decodedVideo && renderedVideo && inboundAudioBytes > 0
        })
      await expect.poll(() => decodedAudioFlow(a), { timeout: 20000 }).toBe(true)
      await expect.poll(() => decodedAudioFlow(b), { timeout: 20000 }).toBe(true)
      await expect.poll(() => playableVideos(a), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => playableVideos(b), { timeout: 20000 }).toBeGreaterThanOrEqual(1)

      await a.getByRole("button", { name: "Connection diagnostics" }).click()
      await expect(a.getByText("Peer to peer")).toBeVisible()
      await expect(a.getByText("Path").locator("..").getByText("Direct", { exact: true })).toBeVisible({
        timeout: 20000,
      })
      await a.keyboard.press("Escape")

      await a.getByRole("button", { name: "Mute", exact: true }).click()
      await expect(a.getByRole("button", { name: "Unmute", exact: true })).toBeVisible()
      await expect(b.getByLabel("Muted")).toBeVisible({ timeout: 10000 })
      await b.waitForTimeout(1000)
      const mutedAudio = await inboundMedia(b)
      await b.waitForTimeout(1500)
      const stillMutedAudio = await inboundMedia(b)
      expect(stillMutedAudio.audioEnergy - mutedAudio.audioEnergy).toBeLessThan(0.0001)
      await a.getByRole("button", { name: "Unmute", exact: true }).click()
      await expect(b.getByLabel("Muted")).toHaveCount(0, { timeout: 10000 })
      await expect
        .poll(async () => (await inboundMedia(b)).audioEnergy, { timeout: 10000 })
        .toBeGreaterThan(stillMutedAudio.audioEnergy)
      await a.getByRole("button", { name: "Turn camera off" }).click()
      await expect.poll(() => playableVideos(b), { timeout: 20000 }).toBe(1)
      const cameraOffMedia = await inboundMedia(b)
      await a.getByRole("button", { name: "Turn camera on" }).click()
      await expect
        .poll(async () => (await inboundMedia(b)).videoFrames, { timeout: 20000 })
        .toBeGreaterThan(cameraOffMedia.videoFrames)
      await expect.poll(() => playableVideos(b), { timeout: 20000 }).toBeGreaterThanOrEqual(2)

      const beforeReload = await readSelf()
      await b.reload()
      await b.goto(`/w/${workspaceId}/s/${dmStreamId}`)
      await expect(b.getByText(/still in this call/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Take over", exact: true }).first().click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect.poll(async () => (await readSelf()).mediaIncarnation).not.toBe(beforeReload.mediaIncarnation)
      expect((await readSelf()).endpointId).toBe(beforeReload.endpointId)
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await b.getByRole("button", { name: "Turn camera on" }).click()
      await expect.poll(() => playableVideos(a), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => playableVideos(b), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => decodedAudioFlow(a), { timeout: 20000 }).toBe(true)
      await expect.poll(() => decodedAudioFlow(b), { timeout: 20000 }).toBe(true)

      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(1, { timeout: 20000 })
      await expect(b.locator("body > audio")).toHaveCount(0, { timeout: 10000 })
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("happy path: ring → accept → both docks converge → leave → ended card", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b } = pair
    try {
      // A starts the call; B's overlay rings.
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })

      // B accepts → both docks show 2 participants (control-plane roster).
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      // A leaves → A's dock tears down; B is now alone in the call.
      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(1, { timeout: 20000 })

      // B leaves → the call empties → grace → ended; the timeline card flips for both.
      await b.getByRole("button", { name: "Leave call" }).click()
      await expect(b.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })

      await expect(a.getByText(/Call ended/i)).toBeVisible({ timeout: 30000 })
      await expect(b.getByText(/Call ended/i)).toBeVisible({ timeout: 30000 })
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("decline: B declines → ring settles, A stays in the call", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b } = pair
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })

      await b.getByRole("button", { name: "Decline call" }).click()
      // B's ring overlay clears; A remains connected (still a live dock).
      await expect(b.getByText(/is calling/i)).toHaveCount(0, { timeout: 20000 })
      await expect(a.locator(CALL_TILE)).toHaveCount(1, { timeout: 10000 })

      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("abandonment: A hangs up before answer → B's ring clears, no missed call", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b, workspaceId } = pair
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })

      // A hangs up while still the only participant — the 1.3 regression: this must
      // CANCEL the ring, not let it expire into a missed-call activity for B.
      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })

      // B's overlay clears via the settle broadcast.
      await expect(b.getByText(/is calling/i)).toHaveCount(0, { timeout: 20000 })

      // Give grace + sweep time to fire, then assert B has NO missed-call
      // activity. The 45s ring-expiry path is NOT waited out here — it doesn't
      // need to be: the overlay-clears-within-20s assertion above can only pass
      // via a real server settle (the client auto-dismiss backstop fires at 45s),
      // and a settled ring is out of 'ringing', so a later expiry sweep can't
      // turn it into a missed call.
      await b.waitForTimeout(6000)
      const activities = (await b.request.get(`/api/workspaces/${workspaceId}/activity`).then((r) => r.json())) as {
        activities: Array<{ activityType: string }>
      }
      const missed = activities.activities.filter((row) => row.activityType === "missed_call")
      expect(missed).toHaveLength(0)
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("takeover: A's second device moves the call, and the first device is told where it went", async ({
    browser,
  }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b, workspaceId, dmStreamId, ownerEmail, ownerName } = pair
    // A's second device: the SAME user in a fresh context, so the server sees a
    // second media incarnation on one participant — the CALL_ENDPOINT_ACTIVE case.
    const second = await loginInNewContext(browser, ownerEmail, ownerName)
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      await second.page.goto(`/w/${workspaceId}/s/${dmStreamId}`)

      // The second device knows from the stream's roster that this user is already
      // in the call, so the entry point offers Take over up front — no Join that
      // 409s and then asks. Both the header and the timeline card say so.
      const takeOver = second.page.getByRole("button", { name: "Take over call on this device" })
      await expect(takeOver).toBeVisible({ timeout: 20000 })
      // Exact, so the header's "Take over call on this device" doesn't match. More
      // than one matches by design — the timeline card and the rejoin bar both
      // offer it, in the same words as the header (see rejoin-bar.tsx).
      await expect(second.page.getByRole("button", { name: "Take over", exact: true }).first()).toBeVisible({
        timeout: 20000,
      })
      // Nothing has moved by merely offering it.
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 5000 })

      await takeOver.click()
      await expect(second.page.locator(CALL_TILE)).toHaveCount(2, { timeout: 25000 })
      // Straight in: the 409 prompt is the fallback for what the UI can't see
      // coming, and it must not appear on the path the UI predicted.
      await expect(second.page.getByText(/in this call on another device/i)).toHaveCount(0)

      // The displaced device is told, promptly — not left on a dead call until its
      // lease renew fails 15s later.
      await expect(a.getByText(/moved to another device/i)).toBeVisible({ timeout: 15000 })
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 5000 })
      // B never lost their peer: the identity stayed in the call, only its endpoint moved.
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      // The chip is `fixed right-4` with no left anchor and renders on the branch
      // mobile shares, so measure it at phone width: it must stay on screen, and
      // sit just above the composer rather than floating over the timeline.
      //
      // Seeding `:root` reproduces the reported bug's precondition: that is where
      // `applyPersistedComposerHeight` writes a previous session's composer height
      // at boot, and the chip mounts outside every `[data-editor-zone]`, so it
      // reads that value and nothing else. Seed before the resize, which makes the
      // live composer re-measure — the correction under test.
      await a.evaluate(() => document.documentElement.style.setProperty("--composer-height", "350px"))
      await a.setViewportSize({ width: 360, height: 740 })
      const chip = a.getByText(/moved to another device/i).locator("xpath=ancestor::div[1]")
      const box = await chip.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(360)

      // DOCK_BOTTOM's `+ 1rem` above the real composer, measured against the
      // composer's own box so no persisted approximation can satisfy it. Asserted
      // as a distance from 16px so an overlap fails as loudly as a float.
      const composer = a.locator("[data-message-composer-root]").first()
      await expect
        .poll(
          async () => {
            const chipBox = await chip.boundingBox()
            const composerBox = await composer.boundingBox()
            if (!chipBox || !composerBox) return Number.POSITIVE_INFINITY
            return Math.abs(composerBox.y - (chipBox.y + chipBox.height) - 16)
          },
          { timeout: 5000 }
        )
        .toBeLessThanOrEqual(4)

      await expect(chip.getByRole("button", { name: "Rejoin here" })).toBeVisible()
      await expect(chip.getByRole("button", { name: "Dismiss" })).toBeVisible()

      await second.page.getByRole("button", { name: "Leave call" }).click()
      await b.getByRole("button", { name: "Leave call" }).click()
    } finally {
      await second.context.close()
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("rejoin: A reloads mid-call → rejoin bar → both docks reconverge", async ({ browser }) => {
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser)
    const { ownerPage: a, inviteePage: b, workspaceId, dmStreamId } = pair
    try {
      await startCallFromHeader(a)
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })

      // A reloads: the media incarnation is gone, but A's `joined` participant row
      // survives under its lease (B keeps the call active), so the rejoin bar shows.
      await a.reload()
      await a.goto(`/w/${workspaceId}/s/${dmStreamId}`)
      await expect(a.getByText(/still in this call/i)).toBeVisible({ timeout: 25000 })

      // One wording across the bar, the header and the card — see rejoin-bar.tsx.
      await a.getByRole("button", { name: "Take over", exact: true }).first().click()
      // Both docks converge back to 2 participants.
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 25000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 25000 })

      await a.getByRole("button", { name: "Leave call" }).click()
      await b.getByRole("button", { name: "Leave call" }).click()
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })
})
