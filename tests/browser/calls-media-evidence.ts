import { expect, type BrowserContext, type Page, type Route } from "@playwright/test"

export async function installPeerConnectionObserver(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection
    const peers: RTCPeerConnection[] = []
    const trace: unknown[] = []
    const record = (event: Record<string, unknown>) => trace.push({ at: performance.now(), ...event })
    const glare = {
      holdNextPeerOffer: false,
      offerApplied: false,
      rollbackCount: 0,
      releaseOffer: null as (() => void) | null,
    }
    Object.defineProperty(window, "__testCallPeerConnections", { value: peers })
    Object.defineProperty(window, "__testCallGlare", { value: glare })
    Object.defineProperty(window, "__testCallRecoveryTrace", { value: trace })
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(Target, args) {
        const peer = new Target(...(args as ConstructorParameters<typeof RTCPeerConnection>))
        const index = peers.push(peer) - 1
        const state = () =>
          record({
            event: "state",
            peer: index,
            connection: peer.connectionState,
            ice: peer.iceConnectionState,
            signaling: peer.signalingState,
          })
        peer.addEventListener("connectionstatechange", state)
        peer.addEventListener("iceconnectionstatechange", state)
        peer.addEventListener("signalingstatechange", state)
        const nativeSetLocalDescription = peer.setLocalDescription.bind(peer)
        const nativeSetRemoteDescription = peer.setRemoteDescription.bind(peer)
        peer.setLocalDescription = async (description?: RTCLocalSessionDescriptionInit) => {
          const type = description?.type ?? "implicit"
          try {
            await nativeSetLocalDescription(description)
            record({ event: "operation", peer: index, operation: "setLocalDescription", type, result: "applied" })
          } catch (error) {
            record({
              event: "operation",
              peer: index,
              operation: "setLocalDescription",
              type,
              result: "error",
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            })
            throw error
          }
          if (description?.type === "rollback") glare.rollbackCount++
          if (!glare.holdNextPeerOffer || description?.type !== "offer" || glare.offerApplied) return
          glare.holdNextPeerOffer = false
          glare.offerApplied = true
          await new Promise<void>((resolve) => {
            glare.releaseOffer = resolve
          })
        }
        peer.setRemoteDescription = async (description) => {
          try {
            await nativeSetRemoteDescription(description)
            record({
              event: "operation",
              peer: index,
              operation: "setRemoteDescription",
              type: description.type,
              result: "applied",
            })
          } catch (error) {
            record({
              event: "operation",
              peer: index,
              operation: "setRemoteDescription",
              type: description.type,
              result: "error",
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            })
            throw error
          }
        }
        state()
        return peer
      },
    })
  })
}

export async function preparePoliteRecoveryGlare(page: Page): Promise<void> {
  await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __testCallPeerConnections?: RTCPeerConnection[]
      __testCallGlare?: { holdNextPeerOffer: boolean }
      __testCallRecoveryTrace?: unknown[]
    }
    const peers = (testWindow.__testCallPeerConnections ?? []).filter((peer) => peer.connectionState !== "closed")
    if (peers.length !== 1) throw new Error(`Expected one active peer connection, found ${peers.length}`)
    if (!testWindow.__testCallGlare) throw new Error("Missing glare observer")
    testWindow.__testCallGlare.holdNextPeerOffer = true
    const peer = peers[0]
    const nativeCreateOffer = peer.createOffer.bind(peer)
    peer.createOffer = async (...args) => {
      peer.createOffer = nativeCreateOffer
      testWindow.__testCallRecoveryTrace?.push({
        at: performance.now(),
        event: "operation",
        peer: (testWindow.__testCallPeerConnections ?? []).indexOf(peer),
        operation: "createOffer",
        result: "error",
        error: "OperationError: Synthetic one-shot offer failure",
      })
      throw new DOMException("Synthetic one-shot offer failure", "OperationError")
    }
  })
  await simulatePeerConnectionFailure(page)
}

export async function hasAppliedHeldPeerOffer(page: Page): Promise<boolean> {
  return page.evaluate(
    () => !!(window as typeof window & { __testCallGlare?: { offerApplied: boolean } }).__testCallGlare?.offerApplied
  )
}

export async function simulatePeerConnectionFailure(page: Page): Promise<void> {
  await page.evaluate(() => {
    const peers = (
      (window as typeof window & { __testCallPeerConnections?: RTCPeerConnection[] }).__testCallPeerConnections ?? []
    ).filter((peer) => peer.connectionState !== "closed")
    if (peers.length !== 1) throw new Error(`Expected one active peer connection, found ${peers.length}`)
    const peer = peers[0]
    Object.defineProperty(peer, "connectionState", { configurable: true, value: "failed" })
    try {
      peer.dispatchEvent(new Event("connectionstatechange"))
    } finally {
      Reflect.deleteProperty(peer, "connectionState")
    }
  })
}

export async function releaseHeldPeerOffer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const glare = (window as typeof window & { __testCallGlare?: { releaseOffer: (() => void) | null } })
      .__testCallGlare
    if (!glare?.releaseOffer) throw new Error("No held peer offer")
    glare.releaseOffer()
    glare.releaseOffer = null
  })
}

export async function readPeerRecoverySample(page: Page, label: string) {
  return page.evaluate(async (sampleLabel) => {
    const testWindow = window as typeof window & {
      __testCallPeerConnections?: RTCPeerConnection[]
      __testCallRecoveryTrace?: unknown[]
    }
    const codecs = (stats: RTCStatsReport) => {
      const result = new Map<string, { mimeType: string | null; payloadType: number | null }>()
      stats.forEach((report) => {
        if (report.type === "codec")
          result.set(report.id, { mimeType: report.mimeType ?? null, payloadType: report.payloadType ?? null })
      })
      return result
    }
    const peers = await Promise.all(
      (testWindow.__testCallPeerConnections ?? []).map(async (peer, index) => {
        const stats = await peer.getStats()
        const codecById = codecs(stats)
        const rtp: unknown[] = []
        let dtls: string | null = null
        stats.forEach((report) => {
          if (report.type === "transport") dtls = report.dtlsState ?? null
          if (report.type !== "outbound-rtp" && report.type !== "inbound-rtp") return
          const kind = report.kind ?? report.mediaType
          if (kind !== "video") return
          rtp.push({
            direction: report.type === "outbound-rtp" ? "outbound" : "inbound",
            ssrc: report.ssrc ?? null,
            codec: codecById.get(report.codecId) ?? null,
            bytes: report.type === "outbound-rtp" ? (report.bytesSent ?? 0) : (report.bytesReceived ?? 0),
            frames: report.type === "outbound-rtp" ? (report.framesEncoded ?? 0) : (report.framesDecoded ?? 0),
            keyframes: report.type === "outbound-rtp" ? (report.keyFramesEncoded ?? 0) : (report.keyFramesDecoded ?? 0),
            pli: report.pliCount ?? 0,
            fir: report.firCount ?? 0,
          })
        })
        return {
          index,
          connection: peer.connectionState,
          ice: peer.iceConnectionState,
          signaling: peer.signalingState,
          dtls,
          localType: peer.localDescription?.type ?? null,
          remoteType: peer.remoteDescription?.type ?? null,
          transceivers: peer
            .getTransceivers()
            .map(({ mid, direction, currentDirection, stopped, sender, receiver }) => ({
              mid,
              direction,
              currentDirection,
              stopped,
              senderTrack: sender.track && {
                id: sender.track.id,
                enabled: sender.track.enabled,
                muted: sender.track.muted,
                readyState: sender.track.readyState,
              },
              encodings: sender.getParameters().encodings,
              receiverTrack: {
                id: receiver.track.id,
                muted: receiver.track.muted,
                readyState: receiver.track.readyState,
              },
            })),
          rtp,
        }
      })
    )
    return {
      label: sampleLabel,
      at: performance.now(),
      peers,
      trace: [...(testWindow.__testCallRecoveryTrace ?? [])],
    }
  }, label)
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
