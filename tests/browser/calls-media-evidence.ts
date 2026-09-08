import { expect, type BrowserContext, type Page, type Route } from "@playwright/test"

export async function installPeerConnectionObserver(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
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
  })
}

export async function installDirectOnlyCredentials(context: BrowserContext, delayMs = 0): Promise<void> {
  await context.route("**/turn-credentials", async (route: Route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ iceServers: [], expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
    })
  })
}

export async function readInboundMedia(page: Page) {
  return page.evaluate(async () => {
    const peers = (
      (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ?? []
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
}

export async function readMediaEdgeEvidence(page: Page) {
  return page.evaluate(async () => {
    const peers = (
      (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ?? []
    ).filter((peer) => peer.connectionState !== "closed")
    const rendered = [...document.querySelectorAll(`[data-testid='call-tile']`)].map((tile) => {
      const video = tile.querySelector("video")
      const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0]
      return {
        userId: tile.getAttribute("data-user-id"),
        trackId: track?.id ?? null,
        readyState: video?.readyState ?? null,
        frames: video?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
        visible: video ? getComputedStyle(video).display !== "none" : false,
      }
    })
    const edges = await Promise.all(
      peers.map(async (peer, index) => {
        const inbound: Record<string, { bytes: number; frames: number }> = {}
        const outbound: Record<string, unknown> = {}
        ;(await peer.getStats()).forEach((report) => {
          if (report.type === "outbound-rtp") {
            outbound[report.kind ?? report.mediaType ?? "unknown"] = {
              bytes: report.bytesSent,
              frames: report.framesEncoded,
              targetBitrate: report.targetBitrate,
              qualityLimitation: report.qualityLimitationReason,
            }
          }
          if (report.type !== "inbound-rtp") return
          const kind = report.kind ?? report.mediaType ?? "unknown"
          inbound[kind] = {
            bytes: report.bytesReceived ?? 0,
            frames: report.framesDecoded ?? 0,
          }
        })
        return {
          index,
          connectionState: peer.connectionState,
          signalingState: peer.signalingState,
          receivers: peer.getReceivers().map(({ track }) => ({ id: track.id, kind: track.kind, muted: track.muted })),
          senders: peer.getSenders().map((sender) => ({
            track: sender.track && {
              id: sender.track.id,
              kind: sender.track.kind,
              enabled: sender.track.enabled,
              muted: sender.track.muted,
              readyState: sender.track.readyState,
            },
            encodings: sender.getParameters().encodings,
          })),
          transceivers: peer
            .getTransceivers()
            .map(({ mid, direction, currentDirection }) => ({ mid, direction, currentDirection })),
          inbound,
          outbound,
        }
      })
    )
    return { edges, rendered, visibilityState: document.visibilityState }
  })
}

export async function hasDecodedMediaOnEveryEdge(page: Page, expectedPeers: number): Promise<boolean> {
  return page.evaluate(async (expected) => {
    const peers = (
      (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ?? []
    ).filter((peer) => peer.connectionState !== "closed")
    if (peers.length !== expected || document.querySelectorAll("body > audio").length !== expected) return false
    const inboundVideoTrackIds = new Set(
      peers.flatMap((peer) =>
        peer
          .getReceivers()
          .filter((receiver) => receiver.track.kind === "video")
          .map((receiver) => receiver.track.id)
      )
    )
    const renderedTrackIds = new Set(
      [...document.querySelectorAll(`[data-testid='call-tile'] video`)].flatMap((node) => {
        const video = node as HTMLVideoElement
        const stream = video.srcObject as MediaStream | null
        if (
          video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          video.videoWidth === 0 ||
          video.videoHeight === 0 ||
          video.getVideoPlaybackQuality().totalVideoFrames === 0
        )
          return []
        return stream?.getVideoTracks().map((track) => track.id) ?? []
      })
    )
    const playingAudioTrackIds = new Set(
      [...document.querySelectorAll("body > audio")].flatMap((node) => {
        const audio = node as HTMLAudioElement
        if (audio.paused || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return []
        return (audio.srcObject as MediaStream | null)?.getAudioTracks().map((track) => track.id) ?? []
      })
    )
    const playable = await Promise.all(
      peers.map(async (peer) => {
        let audioReceived = false
        let videoDecoded = false
        ;(await peer.getStats()).forEach((report) => {
          if (report.type !== "inbound-rtp") return
          const kind = report.kind ?? report.mediaType
          if (kind === "audio") audioReceived ||= report.bytesReceived > 0 && report.totalAudioEnergy > 0
          if (kind === "video") videoDecoded ||= report.bytesReceived > 0 && report.framesDecoded > 0
        })
        const receivers = peer.getReceivers()
        const audio = receivers.find((receiver) => receiver.track.kind === "audio" && !receiver.track.muted)
        const videos = receivers.filter((receiver) => receiver.track.kind === "video")
        return (
          audioReceived &&
          videoDecoded &&
          !!audio &&
          playingAudioTrackIds.has(audio.track.id) &&
          videos.some(
            (receiver) => inboundVideoTrackIds.has(receiver.track.id) && renderedTrackIds.has(receiver.track.id)
          )
        )
      })
    )
    return playable.every(Boolean)
  }, expectedPeers)
}

export async function expectMediaProgressOnEveryEdge(
  page: Page,
  before: Awaited<ReturnType<typeof readMediaEdgeEvidence>>
): Promise<void> {
  await expect
    .poll(
      async () => {
        const after = await readMediaEdgeEvidence(page)
        return (
          after.edges.length === before.edges.length &&
          after.edges.every((edge) => {
            const audioId = edge.receivers.find(({ kind }) => kind === "audio")?.id
            const prior = before.edges.find((previous) => previous.receivers.some(({ id }) => id === audioId))
            return (
              (edge.inbound.audio?.bytes ?? 0) > (prior?.inbound.audio?.bytes ?? 0) &&
              (edge.inbound.video?.frames ?? 0) > (prior?.inbound.video?.frames ?? 0)
            )
          })
        )
      },
      { timeout: 30_000 }
    )
    .toBe(true)
}

export async function expectDecodedMediaOnEveryEdge(page: Page, expectedPeers: number): Promise<void> {
  try {
    await expect
      .poll(() => hasDecodedMediaOnEveryEdge(page, expectedPeers), {
        timeout: 30_000,
        intervals: [1_000, 2_000, 3_000],
      })
      .toBe(true)
  } catch (error) {
    throw new Error(`Media edge proof failed: ${JSON.stringify(await readMediaEdgeEvidence(page))}`, { cause: error })
  }
}
