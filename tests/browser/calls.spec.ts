import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { loginAndCreateWorkspace, loginInNewContext, expectApiOk, createDmDraftId, generateTestId } from "./helpers"
import {
  expectDecodedMediaOnEveryEdge,
  hasAppliedHeldPeerOffer,
  simulatePeerConnectionFailure,
  installDirectOnlyCredentials,
  installPeerConnectionObserver,
  preparePoliteRecoveryGlare,
  readInboundMedia,
  readMediaEdgeEvidence,
  readPeerRecoverySample,
  releaseHeldPeerOffer,
} from "./calls-media-evidence"

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
async function setUpDmPair(
  browser: Browser,
  options: {
    p2p?: boolean | "enroll-after-start"
    inviteeCaptureDelayMs?: number
    inviteeCredentialsDelayMs?: number
  } = {}
): Promise<DmPair> {
  const testId = generateTestId()
  const inviteeEmail = `calls-b-${testId}@example.com`
  const inviteeName = `Calls B ${testId}`

  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  const invitee = await loginInNewContext(browser, inviteeEmail, inviteeName)

  if (options.p2p) {
    await installPeerConnectionObserver(ownerContext)
    await installPeerConnectionObserver(invitee.context)
    for (const context of [ownerContext, invitee.context]) {
      await context.addInitScript(() => {
        if (!navigator.mediaDevices) return
        const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        const captures: Array<{ audio: string[]; video: string[] }> = []
        Object.defineProperty(window, "__testCallCaptures", { value: captures })
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await nativeGetUserMedia(constraints)
          captures.push({
            audio: stream.getAudioTracks().map(({ id }) => id),
            video: stream.getVideoTracks().map(({ id }) => id),
          })
          return stream
        }
      })
    }
    if (options.inviteeCaptureDelayMs) {
      await invitee.context.addInitScript((delayMs) => {
        const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          return nativeGetUserMedia(constraints)
        }
      }, options.inviteeCaptureDelayMs)
    }
    await invitee.page.reload()
    await installDirectOnlyCredentials(ownerContext)
    await installDirectOnlyCredentials(invitee.context, options.inviteeCredentialsDelayMs)
  }

  const owner = await loginAndCreateWorkspace(ownerPage, "calls-a")
  const workspaceId = ownerPage.url().match(/\/w\/([^/]+)/)?.[1]
  if (!workspaceId) throw new Error("Could not resolve workspaceId from owner URL")

  if (options.p2p === true) {
    await enrollCallsP2p(ownerPage, workspaceId)
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
  await ownerPage.getByRole("textbox", { name: "Message input" }).click()
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
  await expect(invitee.page.getByRole("textbox", { name: "Message input" })).toBeVisible({ timeout: 15000 })

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

async function enrollCallsP2p(page: Page, workspaceId: string): Promise<void> {
  const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT
  const internalApiKey = process.env.PLAYWRIGHT_INTERNAL_API_KEY
  if (!backendPort || !internalApiKey) throw new Error("Browser test feature-flag fixture is unavailable")
  await expectApiOk(
    await page.request.post(`http://localhost:${backendPort}/internal/feature-flags`, {
      headers: { "x-internal-api-key": internalApiKey },
      data: { workspaceId, subjectType: "workspace", subjectId: workspaceId, overrides: { callsP2p: "on" } },
    }),
    "Enroll workspace in callsP2p"
  )
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
    test.setTimeout(120000)
    const pair = await setUpDmPair(browser, {
      p2p: true,
      inviteeCaptureDelayMs: 1_500,
      inviteeCredentialsDelayMs: 2_000,
    })
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
      const readSelf = async (page: Page) => {
        const response = await page.request.get(
          new URL(`/api/workspaces/${workspaceId}/calls/${callId}`, page.url()).toString()
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
      const inboundMedia = readInboundMedia
      const decodedMediaFlow = (page: Page) =>
        page.evaluate(async () => {
          const peers = (
            (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ??
            []
          ).filter((peer) => peer.connectionState !== "closed")
          const audioIds = new Set(
            peers.flatMap((peer) =>
              peer
                .getReceivers()
                .filter(({ track }) => track.kind === "audio")
                .map(({ track }) => track.id)
            )
          )
          const details: unknown[] = []
          const outputReady = [...document.querySelectorAll("body > audio")].some((node) => {
            const audio = node as HTMLAudioElement
            return (
              !audio.paused &&
              audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              !!(audio.srcObject as MediaStream | null)
                ?.getAudioTracks()
                .some((track) => track.readyState === "live" && !track.muted && audioIds.has(track.id))
            )
          })
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
            const candidates: unknown[] = []
            stats.forEach((report) => {
              if (report.type === "candidate-pair")
                candidates.push({
                  type: report.type,
                  state: report.state,
                  nominated: report.nominated,
                  requestsSent: report.requestsSent,
                  responsesReceived: report.responsesReceived,
                  bytesSent: report.bytesSent,
                  bytesReceived: report.bytesReceived,
                })
              if (report.type === "local-candidate" || report.type === "remote-candidate")
                candidates.push({
                  type: report.type,
                  candidateType: report.candidateType,
                  mdns: typeof report.address === "string" && report.address.endsWith(".local"),
                })
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
            details.push({
              connection: peer.connectionState,
              signaling: peer.signalingState,
              ice: peer.iceConnectionState,
              gathering: peer.iceGatheringState,
              candidates,
              transceivers: peer.getTransceivers().map((t) => ({
                mid: t.mid,
                direction: t.direction,
                currentDirection: t.currentDirection,
                senderKind: t.sender.track?.kind,
                senderEnabled: t.sender.track?.enabled,
                receiverKind: t.receiver.track.kind,
                receiverMuted: t.receiver.track.muted,
              })),
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
          const result = { outputReady, inboundAudio: inboundAudioBytes > 0, decodedVideo, renderedVideo }
          return Object.values(result).every(Boolean) ? result : { ...result, details }
        })
      const flowingMedia = {
        outputReady: true,
        inboundAudio: true,
        decodedVideo: true,
        renderedVideo: true,
      }
      await expect.poll(() => decodedMediaFlow(a), { timeout: 20000 }).toEqual(flowingMedia)
      await expect.poll(() => decodedMediaFlow(b), { timeout: 20000 }).toEqual(flowingMedia)
      await expect.poll(() => playableVideos(a), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => playableVideos(b), { timeout: 20000 }).toBeGreaterThanOrEqual(1)

      const [aSelf, bSelf] = await Promise.all([readSelf(a), readSelf(b)])
      const polite = aSelf.endpointId.localeCompare(bSelf.endpointId) > 0 ? a : b
      const established = polite === a ? b : a
      const recoverySamples: Array<{ endpoint: string; sample: Awaited<ReturnType<typeof readPeerRecoverySample>> }> =
        []
      const sampleRecovery = async (label: string) => {
        const [aSample, bSample] = await Promise.all([
          readPeerRecoverySample(a, label),
          readPeerRecoverySample(b, label),
        ])
        recoverySamples.push(
          { endpoint: aSelf.endpointId, sample: aSample },
          { endpoint: bSelf.endpointId, sample: bSample }
        )
      }
      const peerIdentity = (page: Page) =>
        page.evaluate(async () => {
          const all =
            (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ??
            []
          const active = all.filter((peer) => peer.connectionState !== "closed")
          if (active.length !== 1)
            return {
              active: active.length,
              index: null,
              mids: [],
              senderTrackIds: [],
              senderSlots: [],
              signalingState: null,
              dtlsState: null,
            }
          const peer = active[0]
          let dtlsState: string | null = null
          ;(await peer.getStats()).forEach((report) => {
            if (report.type === "transport") dtlsState = report.dtlsState ?? null
          })
          return {
            active: 1,
            index: all.indexOf(peer),
            mids: peer.getTransceivers().map(({ mid }) => mid),
            senderTrackIds: peer.getSenders().flatMap(({ track }) => (track ? [track.id] : [])),
            senderSlots: peer.getTransceivers().map(({ mid, stopped, sender }) => ({
              mid,
              stopped,
              trackId: sender.track?.id ?? null,
            })),
            signalingState: peer.signalingState,
            dtlsState,
          }
        })
      const politeBefore = await peerIdentity(polite)
      const establishedBefore = await peerIdentity(established)
      await sampleRecovery("pre-replacement")
      await preparePoliteRecoveryGlare(polite)
      await expect.poll(() => hasAppliedHeldPeerOffer(polite), { timeout: 10000 }).toBe(true)
      await sampleRecovery("replacement-local-offer-applied")
      await simulatePeerConnectionFailure(established)
      await expect
        .poll(() => peerIdentity(established), { timeout: 10000 })
        .toMatchObject({ mids: establishedBefore.mids, signalingState: "have-local-offer" })
      await sampleRecovery("ice-restart-local-offer-applied")
      await releaseHeldPeerOffer(polite)
      for (let index = 0; index < 16; index++) {
        await a.waitForTimeout(500)
        await sampleRecovery(`post-release-${index + 1}`)
      }
      await test.info().attach("p2p-recovery-timeseries", {
        body: JSON.stringify(recoverySamples),
        contentType: "application/json",
      })
      await expect.poll(async () => (await peerIdentity(polite)).index, { timeout: 10000 }).not.toBe(politeBefore.index)
      await expect
        .poll(
          () =>
            polite.evaluate(
              () =>
                (window as typeof window & { __testCallGlare?: { rollbackCount: number } }).__testCallGlare
                  ?.rollbackCount ?? 0
            ),
          { timeout: 10000 }
        )
        .toBeGreaterThan(0)
      await expect.poll(() => decodedMediaFlow(a), { timeout: 20000 }).toEqual(flowingMedia)
      await expect.poll(() => decodedMediaFlow(b), { timeout: 20000 }).toEqual(flowingMedia)
      await expect.poll(() => polite.locator("body > audio").count(), { timeout: 10000 }).toBe(1)
      await expect.poll(() => established.locator("body > audio").count(), { timeout: 10000 }).toBe(1)
      await expect
        .poll(() => peerIdentity(polite), { timeout: 10000 })
        .toMatchObject({
          active: 1,
          senderTrackIds: politeBefore.senderTrackIds,
          senderSlots: [
            { mid: null, stopped: true, trackId: null },
            { mid: null, stopped: true, trackId: null },
            { mid: "0", stopped: false },
            { mid: "1", stopped: false },
          ],
          dtlsState: "connected",
        })
      await expect
        .poll(() => peerIdentity(established), { timeout: 10000 })
        .toMatchObject({
          active: 1,
          index: establishedBefore.index,
          mids: establishedBefore.mids,
          dtlsState: "connected",
        })
      const beforeQuiet = await Promise.all([a, b].map((page) => readPeerRecoverySample(page, "quiet-before")))
      await a.waitForTimeout(1500)
      const afterQuiet = await Promise.all([a, b].map((page) => readPeerRecoverySample(page, "quiet-after")))
      const sdpOperations = (samples: typeof beforeQuiet) =>
        samples.map(({ trace }) => trace.filter((event) => (event as { event: string }).event === "operation"))
      expect(sdpOperations(afterQuiet)).toEqual(sdpOperations(beforeQuiet))

      await a.getByRole("button", { name: "Connection diagnostics" }).click()
      await expect(a.getByText("Peer to peer")).toBeVisible()
      await expect(a.getByText("Path").locator("..").getByText("Direct", { exact: true })).toBeVisible({
        timeout: 20000,
      })
      await a.keyboard.press("Escape")

      await a.getByRole("button", { name: "Mute", exact: true }).click()
      await expect(a.getByRole("button", { name: "Unmute", exact: true })).toBeVisible()
      await expect(b.getByLabel("Muted")).toBeVisible({ timeout: 10000 })
      let priorMutedEnergy = (await inboundMedia(b)).audioEnergy
      let stableMutedSamples = 0
      await expect
        .poll(
          async () => {
            const currentEnergy = (await inboundMedia(b)).audioEnergy
            stableMutedSamples = currentEnergy - priorMutedEnergy < 0.0001 ? stableMutedSamples + 1 : 0
            priorMutedEnergy = currentEnergy
            return stableMutedSamples
          },
          { timeout: 10000, intervals: [250] }
        )
        .toBeGreaterThanOrEqual(2)
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

      const beforeReload = await readSelf(b)
      await b.reload()
      await b.goto(`/w/${workspaceId}/s/${dmStreamId}`)
      await expect(b.getByText(/still in this call/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Take over", exact: true }).first().click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect.poll(async () => (await readSelf(b)).mediaIncarnation).not.toBe(beforeReload.mediaIncarnation)
      expect((await readSelf(b)).endpointId).toBe(beforeReload.endpointId)
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await b.getByRole("button", { name: "Turn camera on" }).click()
      await expect.poll(() => playableVideos(a), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => playableVideos(b), { timeout: 20000 }).toBeGreaterThanOrEqual(1)
      await expect.poll(() => decodedMediaFlow(a), { timeout: 20000 }).toEqual(flowingMedia)
      await expect.poll(() => decodedMediaFlow(b), { timeout: 20000 }).toEqual(flowingMedia)

      await a.getByRole("button", { name: "Leave call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(0, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(1, { timeout: 20000 })
      await expect(b.locator("body > audio")).toHaveCount(0, { timeout: 10000 })
    } finally {
      await pair.ownerContext.close()
      await pair.inviteeContext.close()
    }
  })

  test("explicit SFU to P2P completes with media, then an unready SFU target preserves P2P", async ({ browser }) => {
    test.setTimeout(165000)
    const pair = await setUpDmPair(browser, { p2p: "enroll-after-start" })
    const { ownerPage: a, inviteePage: b, workspaceId } = pair
    let readyPosts = 0
    const credentialAttempts = new Map<Page, number>()
    const switchedBodies = new Map<Page, unknown[]>()
    for (const page of [a, b]) {
      credentialAttempts.set(page, 0)
      switchedBodies.set(page, [])
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/transport-transfers/ready")) readyPosts++
      })
      await page.route("**/turn-credentials", async (route) => {
        const attempts = credentialAttempts.get(page) ?? 0
        credentialAttempts.set(page, attempts + 1)
        if (attempts === 0) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "injected setup failure" }),
          })
          return
        }
        await route.fallback()
      })
      await page.route("**/transport-transfers/switched", async (route) => {
        const bodies = switchedBodies.get(page)!
        bodies.push(route.request().postDataJSON())
        if (bodies.length === 1) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "injected lost acknowledgement" }),
          })
          return
        }
        await route.fallback()
      })
    }
    try {
      const startedResponse = a.waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().endsWith(`/workspaces/${workspaceId}/calls`)
      )
      await a.getByRole("button", { name: "Start a call" }).click()
      await a.getByRole("menuitem", { name: "Start video call" }).click()
      const started = await startedResponse
      await expectApiOk(started, "Start SFU video call")
      const callId = (await started.json()).call.id as string
      await expect(b.getByText(/is calling/i)).toBeVisible({ timeout: 20000 })
      await b.getByRole("button", { name: "Accept call" }).click()
      await expect(a.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await expect(b.locator(CALL_TILE)).toHaveCount(2, { timeout: 20000 })
      await b.getByRole("button", { name: "Turn camera on" }).click()

      const getSnapshot = async (page: Page) => {
        const response = await page.request.get(`/api/workspaces/${workspaceId}/calls/${callId}`)
        await expectApiOk(response, "Read transfer snapshot")
        return (await response.json()) as {
          mediaTransport: "sfu" | "p2p"
          transportGeneration: number
          transfer: null | {
            phase: string
            target: { generation: number; transport: "sfu" | "p2p" }
            failureCode: string | null
            obligations: Array<{ ownPublicationsReady: boolean; switched: boolean }>
          }
        }
      }
      expect(await getSnapshot(a)).toMatchObject({ mediaTransport: "sfu", transportGeneration: 1 })
      await enrollCallsP2p(a, workspaceId)
      const capturesBeforeForward = await Promise.all(
        [a, b].map((page) =>
          page.evaluate(
            () =>
              (window as typeof window & { __testCallCaptures?: Array<{ audio: string[]; video: string[] }> })
                .__testCallCaptures ?? []
          )
        )
      )

      await a.getByRole("button", { name: "Connection diagnostics" }).click()
      await a.getByRole("button", { name: "Switch to Peer to peer" }).click()
      await a.keyboard.press("Escape")
      const targetMediaFlows = async (page: Page) => {
        const evidence = await readMediaEdgeEvidence(page)
        return evidence.edges.some(
          (edge) =>
            edge.connectionState === "connected" &&
            (edge.inbound.audio?.bytes ?? 0) > 0 &&
            (edge.inbound.video?.bytes ?? 0) > 0 &&
            (edge.inbound.video?.frames ?? 0) > 0
        )
      }
      const sourceMediaSelected = async (page: Page) => {
        const evidence = await readMediaEdgeEvidence(page)
        const source = evidence.edges.find((edge) => edge.connectionState === "connected")
        const inboundVideoIds = new Set(
          source?.receivers.filter(({ kind }) => kind === "video").map(({ id }) => id) ?? []
        )
        return (
          !!source &&
          (source.inbound.audio?.bytes ?? 0) > 0 &&
          (source.inbound.video?.frames ?? 0) > 0 &&
          evidence.rendered.some(({ trackId, frames }) => !!trackId && inboundVideoIds.has(trackId) && frames > 0) &&
          (await page.locator("body > audio").count()) === 1
        )
      }
      await Promise.all([
        expect.poll(() => targetMediaFlows(a), { timeout: 30000 }).toBe(true),
        expect.poll(() => targetMediaFlows(b), { timeout: 30000 }).toBe(true),
      ])
      await expect.poll(() => readyPosts, { timeout: 10000 }).toBeGreaterThan(0)
      await expect.poll(() => [...credentialAttempts.values()], { timeout: 10000 }).toEqual([2, 2])
      await expect
        .poll(() => [...switchedBodies.values()].map((bodies) => bodies.length), { timeout: 10000 })
        .toEqual([2, 2])
      for (const bodies of switchedBodies.values()) expect(bodies[1]).toEqual(bodies[0])
      await expect
        .poll(async () => await getSnapshot(a), { timeout: 30000 })
        .toMatchObject({ mediaTransport: "p2p", transportGeneration: 2 })
      await expect.poll(async () => (await getSnapshot(a)).transfer?.phase, { timeout: 10000 }).toBe("completed")
      await Promise.all([expectDecodedMediaOnEveryEdge(a, 1), expectDecodedMediaOnEveryEdge(b, 1)])
      const capturesAfterForward = await Promise.all(
        [a, b].map((page) =>
          page.evaluate(
            () =>
              (window as typeof window & { __testCallCaptures?: Array<{ audio: string[]; video: string[] }> })
                .__testCallCaptures ?? []
          )
        )
      )
      expect(capturesAfterForward).toEqual(capturesBeforeForward)
      const timerBefore = await a.getByLabel("Call duration").textContent()

      await a.getByRole("button", { name: "Connection diagnostics" }).click()
      await a.getByRole("button", { name: "Switch to Cloudflare SFU" }).click()
      await a.keyboard.press("Escape")
      await expect.poll(async () => (await getSnapshot(a)).transfer?.phase, { timeout: 10000 }).toBe("preparing")
      await a.getByRole("button", { name: "Mute", exact: true }).click()
      await expect(b.getByLabel("Muted")).toBeVisible({ timeout: 10000 })
      await a.getByRole("button", { name: "Unmute", exact: true }).click()
      await expect(b.getByLabel("Muted")).toHaveCount(0, { timeout: 10000 })
      await a.getByRole("button", { name: "Turn camera off" }).click()
      await expect
        .poll(async () => (await readMediaEdgeEvidence(b)).rendered.filter(({ trackId }) => trackId).length, {
          timeout: 10000,
        })
        .toBe(1)
      await a.getByRole("button", { name: "Turn camera on" }).click()
      await expect.poll(() => sourceMediaSelected(b), { timeout: 20000 }).toBe(true)
      const [beforeAbortA, beforeAbortB] = await Promise.all([readMediaEdgeEvidence(a), readMediaEdgeEvidence(b)])
      const capturesBeforeAbort = await Promise.all(
        [a, b].map((page) =>
          page.evaluate(
            () =>
              (window as typeof window & { __testCallCaptures?: Array<{ audio: string[]; video: string[] }> })
                .__testCallCaptures ?? []
          )
        )
      )

      await expect
        .poll(
          async () => {
            const transfer = (await getSnapshot(a)).transfer
            return (
              transfer && {
                phase: transfer.phase,
                failureCode: transfer.failureCode,
                anyReady: transfer.obligations.some(({ ownPublicationsReady }) => ownPublicationsReady),
                anySwitched: transfer.obligations.some(({ switched }) => switched),
              }
            )
          },
          { timeout: 45000, intervals: [1000] }
        )
        .toEqual({ phase: "failed", failureCode: "PREPARE_TIMEOUT", anyReady: false, anySwitched: false })
      expect(await getSnapshot(a)).toMatchObject({ mediaTransport: "p2p", transportGeneration: 2 })
      await Promise.all([
        expect.poll(() => sourceMediaSelected(a), { timeout: 30000 }).toBe(true),
        expect.poll(() => sourceMediaSelected(b), { timeout: 30000 }).toBe(true),
      ])
      const sourceProgressed = async (page: Page, before: Awaited<ReturnType<typeof readMediaEdgeEvidence>>) => {
        const prior = before.edges.find((edge) => edge.connectionState === "connected")
        const after = (await readMediaEdgeEvidence(page)).edges.find((edge) => edge.connectionState === "connected")
        return (
          !!prior &&
          !!after &&
          (after.inbound.audio?.bytes ?? 0) > (prior.inbound.audio?.bytes ?? 0) &&
          (after.inbound.video?.frames ?? 0) > (prior.inbound.video?.frames ?? 0)
        )
      }
      await Promise.all([
        expect.poll(() => sourceProgressed(a, beforeAbortA), { timeout: 30000 }).toBe(true),
        expect.poll(() => sourceProgressed(b, beforeAbortB), { timeout: 30000 }).toBe(true),
      ])
      await expect(a.locator("body > audio")).toHaveCount(1)
      await expect(b.locator("body > audio")).toHaveCount(1)
      const capturesAfter = await Promise.all(
        [a, b].map((page) =>
          page.evaluate(
            () =>
              (window as typeof window & { __testCallCaptures?: Array<{ audio: string[]; video: string[] }> })
                .__testCallCaptures ?? []
          )
        )
      )
      expect(capturesAfter).toEqual(capturesBeforeAbort)
      expect(await a.getByLabel("Call duration").textContent()).not.toBe("0:00")
      expect(timerBefore).not.toBeNull()
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
