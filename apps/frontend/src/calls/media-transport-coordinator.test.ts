import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { CallTransportTransfer } from "@threahq/types"
import { MediaTransportCoordinator } from "./media-transport-coordinator"
import type { MediaTransport, RemoteTrackEvent, TransportConnectionState, TransportStats } from "./media-transport"

class FakeTransport implements MediaTransport {
  connectionState: TransportConnectionState = "new"
  onRemoteTrack: ((event: RemoteTrackEvent) => void) | null = null
  onRemoteTrackEnded: ((ref: RemoteTrackEvent["ref"]) => void) | null = null
  onConnectionStateChange: ((state: TransportConnectionState) => void) | null = null
  connect = vi.fn(async () => {
    this.connectionState = "connected"
  })
  publish = vi.fn(async () => {})
  unpublish = vi.fn(async () => {})
  setPublishEncoding = vi.fn(async () => {})
  setPeerPublishEncoding = vi.fn(async () => {})
  pull = vi.fn(async () => {})
  stopPull = vi.fn(async () => {})
  syncPeers = vi.fn(async () => {})
  inboundProgress = true
  ownPublicationsReady = true
  hasInboundByteProgress = vi.fn(async () => this.inboundProgress)
  hasEstablishedOwnPublications = vi.fn(() => this.ownPublicationsReady)
  close = vi.fn(async () => {
    this.connectionState = "closed"
  })
  stats: TransportStats = { rttMs: null, packetLoss: null, qualityLimitation: null, encodeTimeMs: null }
  async getStats() {
    return this.stats
  }
}

const coordinators: MediaTransportCoordinator[] = []

function createCoordinator(
  ...args: ConstructorParameters<typeof MediaTransportCoordinator>
): MediaTransportCoordinator {
  const coordinator = new MediaTransportCoordinator(...args)
  coordinators.push(coordinator)
  return coordinator
}

function track(kind: "audio" | "video", id: string): MediaStreamTrack {
  return { kind, id, readyState: "live" } as MediaStreamTrack
}

function snapshot(phase: CallTransportTransfer["phase"] = "preparing"): CallTransportTransfer {
  return {
    id: "callxfer_1",
    version: 1,
    source: { generation: 1, transport: "sfu" },
    target: { generation: 2, transport: "p2p" },
    membershipRevision: 4,
    phase,
    cause: "explicit",
    failureCode: null,
    recoveryCode: null,
    sessions: [
      {
        id: "calltsess_self",
        endpointId: "self",
        endpointEpoch: 1,
        mediaIncarnation: "inc_self",
        generation: 2,
        transport: "p2p",
        status: "preparing",
        providerSessionId: null,
        publicationRevision: 1,
        publishedTracks: [],
      },
    ],
    obligations: [],
  }
}

describe("MediaTransportCoordinator", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: MediaStreamTrack[]) {}
      }
    )
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
    Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(async () => {
    for (const coordinator of coordinators.splice(0)) await coordinator.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (HTMLVideoElement.prototype as Partial<HTMLVideoElement>).requestVideoFrameCallback
  })

  test("should publish the same capture objects to source and target", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    const mic = track("audio", "mic_1")
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("mic", mic)
    await coordinator.beginTransfer(snapshot())

    expect({
      source: source.publish.mock.calls as unknown[][],
      target: target.publish.mock.calls as unknown[][],
    }).toEqual({ source: [["mic", mic]], target: [["mic", mic]] })
  })

  test("should preserve a successful source unpublish when the target unpublish fails", async () => {
    const source = new FakeTransport()
    const failedTarget = new FakeTransport()
    failedTarget.unpublish.mockRejectedValueOnce(new Error("target unavailable"))
    const replacementTarget = new FakeTransport()
    const targets = [failedTarget, replacementTarget]
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => targets.shift()!)
    const camera = track("video", "camera_1")
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("camera", camera)
    await coordinator.beginTransfer(snapshot())

    await expect(coordinator.unpublish("camera")).resolves.toBeUndefined()
    await coordinator.abortTarget(2)
    await coordinator.beginTransfer({ ...snapshot(), id: "callxfer_2", target: { generation: 3, transport: "p2p" } })

    expect({
      sourceUnpublished: source.unpublish.mock.calls as unknown[][],
      failedTargetUnpublished: failedTarget.unpublish.mock.calls as unknown[][],
      replacementTargetPublished: replacementTarget.publish.mock.calls as unknown[][],
    }).toEqual({
      sourceUnpublished: [["camera", undefined]],
      failedTargetUnpublished: [["camera", undefined]],
      replacementTargetPublished: [],
    })
  })

  test("should sync target peers from generation-qualified sessions", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    const transfer = snapshot()
    transfer.sessions.push({
      id: "calltsess_peer",
      endpointId: "peer",
      endpointEpoch: 3,
      mediaIncarnation: "inc_peer",
      generation: 2,
      transport: "p2p",
      status: "preparing",
      providerSessionId: null,
      publicationRevision: 4,
      publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "mic_target", transportGeneration: 2 }],
    })
    await coordinator.beginTransfer(transfer)

    expect(target.syncPeers).toHaveBeenCalledWith(
      [
        {
          endpointId: "peer",
          epoch: 3,
          mediaIncarnation: "inc_peer",
          publications: [
            { ref: { endpointId: "peer", kind: "mic", publicationId: "mic_target" }, providerLocator: undefined },
          ],
        },
      ],
      2
    )
  })

  test("should pull target publications after syncing their real SFU locators", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "p2p" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    const transfer = snapshot()
    transfer.target.transport = "sfu"
    transfer.sessions.push({
      id: "calltsess_peer",
      endpointId: "peer",
      endpointEpoch: 3,
      mediaIncarnation: "inc_peer",
      generation: 2,
      transport: "sfu",
      status: "preparing",
      providerSessionId: "cf_peer",
      publicationRevision: 4,
      publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "mic_target", transportGeneration: 2 }],
    })

    await coordinator.beginTransfer(transfer)

    expect(target.pull).toHaveBeenCalledWith({ endpointId: "peer", kind: "mic", publicationId: "mic_target" })
    expect(target.syncPeers.mock.invocationCallOrder[0]).toBeLessThan(target.pull.mock.invocationCallOrder[0]!)
  })

  test("should stage target video until rendered and ignore retired source callbacks", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const selected = vi.fn(() => {})
    const ended = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    coordinator.onRemoteTrack = selected
    coordinator.onRemoteTrackEnded = ended
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    const ref = { endpointId: "peer", kind: "camera" as const, publicationId: "camera_2" }
    const video = track("video", "video_2")
    target.onRemoteTrack?.({ ref, track: video })
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "camera" as const,
        publicationId: "camera_2",
        publicationRevision: 3,
      },
    ]

    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: false, publications: [] })
    await coordinator.markVideoRendered(ref, 2)
    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: true, publications: expected })
    expect(selected).not.toHaveBeenCalled()
    coordinator.commitSelection(2, expected)
    expect(selected).toHaveBeenCalledWith({ ref, track: video })
    await coordinator.drainSource(2)
    source.onRemoteTrackEnded?.(ref)
    expect(ended).not.toHaveBeenCalled()
  })

  test("should reject commit after a ready target publication ends", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const selected = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    coordinator.onRemoteTrack = selected
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    const ref = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_2" }
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic" as const,
        publicationId: "mic_2",
        publicationRevision: 3,
        muted: false,
      },
    ]
    target.onRemoteTrack?.({ ref, track: track("audio", "audio_2") })
    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: true, publications: expected })

    target.onRemoteTrackEnded?.(ref)

    expect(coordinator.commitSelection(2, expected)).toBe(false)
    expect(selected).not.toHaveBeenCalled()
  })

  test("should not treat a rendered ended camera track as ready", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    const ref = { endpointId: "peer", kind: "camera" as const, publicationId: "camera_2" }
    const video = track("video", "video_2")
    target.onRemoteTrack?.({ ref, track: video })
    await coordinator.markVideoRendered(ref, 2)
    Object.defineProperty(video, "readyState", { value: "ended" })
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "camera" as const,
        publicationId: "camera_2",
        publicationRevision: 3,
      },
    ]

    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: false, publications: [] })
    expect(coordinator.commitSelection(2, expected)).toBe(false)
  })

  test("should ignore ended callbacks from replaced publications in the same generation", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const ended = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    coordinator.onRemoteTrackEnded = ended
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    const oldRef = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_old" }
    const currentRef = { ...oldRef, publicationId: "mic_current" }
    source.onRemoteTrack?.({ ref: oldRef, track: track("audio", "old") })
    source.onRemoteTrack?.({ ref: currentRef, track: track("audio", "current") })
    source.onRemoteTrackEnded?.(oldRef)

    expect(ended).not.toHaveBeenCalled()
    source.onRemoteTrackEnded?.(currentRef)
    expect(ended).toHaveBeenCalledWith(currentRef)
  })

  test("should require exact target-edge byte progress for an unmuted microphone", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    target.inboundProgress = false
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    const ref = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_2" }
    target.onRemoteTrack?.({ ref, track: track("audio", "audio_2") })
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic" as const,
        publicationId: "mic_2",
        publicationRevision: 3,
        muted: false,
      },
    ]

    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: false, publications: [] })
    expect(target.hasInboundByteProgress).toHaveBeenCalledWith(ref)
    target.inboundProgress = true
    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: true, publications: expected })
    target.inboundProgress = false
    expect(await coordinator.targetReadiness([{ ...expected[0]!, muted: true }])).toEqual({
      ready: true,
      publications: [{ ...expected[0]!, muted: true }],
    })
  })

  test("should poll audio progress and wait for own publication registration", async () => {
    vi.useFakeTimers()
    const source = new FakeTransport()
    const target = new FakeTransport()
    target.inboundProgress = false
    target.ownPublicationsReady = false
    const readinessChanged = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    coordinator.onTargetReadinessChange = readinessChanged
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("mic", track("audio", "own_mic"))
    await coordinator.beginTransfer(snapshot())
    const ref = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_2" }
    target.onRemoteTrack?.({ ref, track: track("audio", "audio_2") })
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic" as const,
        publicationId: "mic_2",
        publicationRevision: 3,
        muted: false,
      },
    ]

    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: false, publications: [] })
    target.inboundProgress = true
    target.ownPublicationsReady = true
    vi.advanceTimersByTime(250)
    await Promise.resolve()
    expect(readinessChanged).toHaveBeenCalled()
    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: true, publications: expected })
    await coordinator.close()
    vi.useRealTimers()
  })

  test("should keep an aborting target alive until source playback is restored and the server settles", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const selected = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    coordinator.onRemoteTrack = selected
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    const sourceRef = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_source" }
    const targetRef = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_target" }
    const sourceTrack = track("audio", "source")
    source.onRemoteTrack?.({ ref: sourceRef, track: sourceTrack })
    await coordinator.beginTransfer(snapshot())
    target.onRemoteTrack?.({ ref: targetRef, track: track("audio", "target") })
    coordinator.commitSelection(2, [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic",
        publicationId: "mic_target",
        publicationRevision: 1,
        muted: false,
      },
    ])

    const aborting = snapshot("aborting")
    aborting.version = 2
    await coordinator.beginTransfer(aborting)
    expect(target.close).not.toHaveBeenCalled()

    source.inboundProgress = false
    expect(
      await coordinator.restoreSourcePlayback(
        [
          {
            endpointId: "peer",
            endpointEpoch: 1,
            mediaIncarnation: "inc_peer",
            kind: "mic",
            publicationId: "mic_target",
            publicationRevision: 1,
            muted: false,
          },
        ],
        2
      )
    ).toBe(false)
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ ref: targetRef }))

    source.inboundProgress = true
    expect(
      await coordinator.restoreSourcePlayback(
        [
          {
            endpointId: "peer",
            endpointEpoch: 1,
            mediaIncarnation: "inc_peer",
            kind: "mic",
            publicationId: "mic_target",
            publicationRevision: 1,
            muted: false,
          },
        ],
        2
      )
    ).toBe(true)
    expect(selected).toHaveBeenLastCalledWith({ ref: sourceRef, track: sourceTrack })
    expect(target.close).not.toHaveBeenCalled()

    const failed = { ...aborting, version: 3, phase: "failed" as const }
    await coordinator.beginTransfer(failed)
    expect(target.close).toHaveBeenCalledTimes(1)
  })

  test("should abort only the target and preserve current source publication", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    const mic = track("audio", "mic_current")
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("mic", mic)
    await coordinator.beginTransfer(snapshot())
    await coordinator.abortTarget(2)

    expect({
      sourceClosed: source.close.mock.calls.length,
      targetClosed: target.close.mock.calls.length,
      sourceUnpublished: source.unpublish.mock.calls.length,
    }).toEqual({
      sourceClosed: 0,
      targetClosed: 1,
      sourceUnpublished: 0,
    })
  })

  test("should promote current target tracks so a later abort restores the current source", async () => {
    const source = new FakeTransport()
    const firstTarget = new FakeTransport()
    const reverseTarget = new FakeTransport()
    const targets = [firstTarget, reverseTarget]
    const selected = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => targets.shift()!)
    coordinator.onRemoteTrack = selected
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    const first = snapshot()
    await coordinator.beginTransfer(first)
    const currentRef = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_2" }
    firstTarget.onRemoteTrack?.({ ref: currentRef, track: track("audio", "current") })
    coordinator.commitSelection(2, [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic",
        publicationId: "mic_2",
        publicationRevision: 1,
        muted: false,
      },
    ])
    await coordinator.drainSource(2)

    const reverse = snapshot()
    reverse.id = "callxfer_2"
    reverse.version = 1
    reverse.source = { generation: 2, transport: "p2p" }
    reverse.target = { generation: 3, transport: "sfu" }
    reverse.sessions[0] = { ...reverse.sessions[0]!, id: "calltsess_self_3", generation: 3, transport: "sfu" }
    await coordinator.beginTransfer(reverse)
    const reverseRef = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_3" }
    reverseTarget.onRemoteTrack?.({ ref: reverseRef, track: track("audio", "reverse") })
    coordinator.commitSelection(3, [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic",
        publicationId: "mic_3",
        publicationRevision: 1,
        muted: false,
      },
    ])
    await coordinator.abortTarget(3)

    expect(selected).toHaveBeenLastCalledWith({ ref: currentRef, track: expect.objectContaining({ id: "current" }) })
  })

  test("should divide one camera budget across SFU and P2P overlap senders", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.syncPeers(
      [
        { endpointId: "peer_1", epoch: 1, mediaIncarnation: "inc_1", publications: [] },
        { endpointId: "peer_2", epoch: 1, mediaIncarnation: "inc_2", publications: [] },
      ],
      1
    )
    const transfer = snapshot()
    for (const endpointId of ["peer_1", "peer_2"]) {
      transfer.sessions.push({
        id: `calltsess_${endpointId}`,
        endpointId,
        endpointEpoch: 1,
        mediaIncarnation: `inc_${endpointId}`,
        generation: 2,
        transport: "p2p",
        status: "preparing",
        providerSessionId: null,
        publicationRevision: 0,
        publishedTracks: [],
      })
    }
    await coordinator.beginTransfer(transfer)
    await coordinator.setPublishEncoding("camera", { maxBitrate: 1_200_000 })
    await coordinator.setPeerPublishEncoding("peer_1", "camera", { maxBitrate: 1_200_000 })

    expect({
      source: source.setPublishEncoding.mock.calls as unknown[][],
      targetAggregate: target.setPublishEncoding.mock.calls as unknown[][],
      targetPeer: target.setPeerPublishEncoding.mock.calls as unknown[][],
    }).toEqual({
      source: [["camera", { maxBitrate: 400_000 }]],
      targetAggregate: [["camera", { maxBitrate: 800_000 }]],
      targetPeer: [["peer_1", "camera", { maxBitrate: 400_000 }]],
    })
  })

  test("should complete a publish-pull-ready switch, reverse, and abort trajectory", async () => {
    const source = new FakeTransport()
    const p2pTarget = new FakeTransport()
    const sfuReverse = new FakeTransport()
    const targets = [p2pTarget, sfuReverse]
    const selected = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => targets.shift()!)
    coordinator.onRemoteTrack = selected
    const mic = track("audio", "own_mic")
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("mic", mic)
    const forward = snapshot()
    forward.sessions.push({
      id: "calltsess_peer_2",
      endpointId: "peer",
      endpointEpoch: 1,
      mediaIncarnation: "inc_peer",
      generation: 2,
      transport: "p2p",
      status: "preparing",
      providerSessionId: null,
      publicationRevision: 1,
      publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "peer_mic_2", transportGeneration: 2 }],
    })
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic" as const,
        publicationId: "peer_mic_2",
        publicationRevision: 1,
        muted: false,
      },
    ]
    await coordinator.beginTransfer(forward)
    p2pTarget.onRemoteTrack?.({
      ref: { endpointId: "peer", kind: "mic", publicationId: "peer_mic_2" },
      track: track("audio", "remote_2"),
    })
    p2pTarget.inboundProgress = true
    expect(await coordinator.targetReadiness(expected)).toEqual({ ready: true, publications: expected })
    expect(coordinator.commitSelection(2, expected)).toBe(true)
    await coordinator.drainSource(2)

    const reverse = snapshot()
    reverse.id = "callxfer_reverse"
    reverse.source = { generation: 2, transport: "p2p" }
    reverse.target = { generation: 3, transport: "sfu" }
    reverse.sessions = [{ ...reverse.sessions[0]!, id: "calltsess_self_3", generation: 3, transport: "sfu" }]
    await coordinator.beginTransfer(reverse)
    await coordinator.abortTarget(3)

    expect({
      ownMicReused:
        (p2pTarget.publish.mock.calls as unknown[][])[0]?.[1] === mic &&
        (sfuReverse.publish.mock.calls as unknown[][])[0]?.[1] === mic,
      targetPulled: p2pTarget.pull.mock.calls as unknown[][],
      forwardClosed: source.close.mock.calls.length,
      abortedClosed: sfuReverse.close.mock.calls.length,
      selected: (selected.mock.calls as unknown[][]).map((call) => (call[0] as RemoteTrackEvent).ref.publicationId),
    }).toEqual({
      ownMicReused: true,
      targetPulled: [[{ endpointId: "peer", kind: "mic", publicationId: "peer_mic_2" }]],
      forwardClosed: 1,
      abortedClosed: 1,
      selected: ["peer_mic_2"],
    })
  })

  test("should forward selected target replacement tracks before source drain", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const selected = vi.fn(() => {})
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    coordinator.onRemoteTrack = selected
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    const first = { endpointId: "peer", kind: "mic" as const, publicationId: "mic_first" }
    const replacement = { ...first, publicationId: "mic_replacement" }
    target.onRemoteTrack?.({ ref: first, track: track("audio", "first") })
    coordinator.commitSelection(2, [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "mic",
        publicationId: "mic_first",
        publicationRevision: 1,
        muted: false,
      },
    ])
    target.onRemoteTrack?.({ ref: replacement, track: track("audio", "replacement") })

    expect(selected).toHaveBeenLastCalledWith({
      ref: replacement,
      track: expect.objectContaining({ id: "replacement" }),
    })
  })

  test("should release superseded target probes before starting the next generation", async () => {
    const source = new FakeTransport()
    const firstTarget = new FakeTransport()
    const secondTarget = new FakeTransport()
    const targets = [firstTarget, secondTarget]
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => targets.shift()!)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    firstTarget.onRemoteTrack?.({
      ref: { endpointId: "peer", kind: "camera", publicationId: "target_camera_2" },
      track: track("video", "target_video_2"),
    })

    const replacement = snapshot()
    replacement.id = "callxfer_2"
    replacement.target = { generation: 3, transport: "sfu" }
    replacement.sessions[0] = { ...replacement.sessions[0]!, id: "calltsess_self_3", generation: 3, transport: "sfu" }
    await coordinator.beginTransfer(replacement)

    expect(document.querySelectorAll('video[aria-hidden="true"]')).toHaveLength(0)
  })

  test("should require decoded source video before acknowledging restoration", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    const renders: Array<() => void> = []
    const frameSpy = vi
      .spyOn(HTMLVideoElement.prototype, "requestVideoFrameCallback")
      .mockImplementation((callback) => {
        renders.push(() => callback(0, {} as VideoFrameCallbackMetadata))
        return 1
      })
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    const sourceRef = { endpointId: "peer", kind: "camera" as const, publicationId: "source_camera" }
    source.onRemoteTrack?.({ ref: sourceRef, track: track("video", "source_video") })
    await coordinator.beginTransfer(snapshot())
    target.onRemoteTrack?.({
      ref: { ...sourceRef, publicationId: "target_camera" },
      track: track("video", "target_video"),
    })
    expect(document.querySelectorAll('video[aria-hidden="true"]')).toHaveLength(2)
    const expected = [
      {
        endpointId: "peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        kind: "camera" as const,
        publicationId: "target_camera",
        publicationRevision: 1,
      },
    ]

    expect(await coordinator.restoreSourcePlayback(expected, 2)).toBe(false)
    renders[0]?.()
    expect(await coordinator.restoreSourcePlayback(expected, 2)).toBe(true)
    frameSpy.mockRestore()
  })

  test("should close transports promptly and fence deferred setup after close", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    let resolveConnect!: () => void
    target.connect = vi.fn(() => new Promise<void>((resolve) => (resolveConnect = resolve)))
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("mic", track("audio", "mic"))
    source.onRemoteTrack?.({
      ref: { endpointId: "peer", kind: "camera", publicationId: "source_camera" },
      track: track("video", "source_camera"),
    })
    expect(document.querySelectorAll('video[aria-hidden="true"]')).toHaveLength(1)
    const setup = coordinator.beginTransfer(snapshot())
    await Promise.resolve()
    const closing = coordinator.close()

    expect({ sourceClosed: source.close.mock.calls.length, targetClosed: target.close.mock.calls.length }).toEqual({
      sourceClosed: 1,
      targetClosed: 1,
    })
    await closing
    expect(document.querySelectorAll('video[aria-hidden="true"]')).toHaveLength(0)
    resolveConnect()
    await setup
    expect(target.publish).not.toHaveBeenCalled()
  })

  test("should apply the overlap cap before target connect and publish", async () => {
    const source = new FakeTransport()
    const target = new FakeTransport()
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "sfu" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.publish("camera", track("video", "camera"))
    await coordinator.setPublishEncoding("camera", { maxBitrate: 1_200_000 })
    await coordinator.beginTransfer(snapshot())

    expect(target.setPublishEncoding.mock.invocationCallOrder[0]).toBeLessThan(
      target.connect.mock.invocationCallOrder[0]!
    )
    expect(target.connect.mock.invocationCallOrder[0]).toBeLessThan(target.publish.mock.invocationCallOrder[0]!)
  })

  test("should retain path totals after source retirement", async () => {
    const source = new FakeTransport()
    source.stats = {
      rttMs: 12,
      packetLoss: 0,
      qualityLimitation: "none",
      encodeTimeMs: 2,
      directBytesSent: 100,
      directBytesReceived: 80,
    }
    const target = new FakeTransport()
    target.stats = {
      rttMs: 20,
      packetLoss: 0,
      qualityLimitation: "none",
      encodeTimeMs: 3,
      relayBytesSent: 40,
      relayBytesReceived: 30,
    }
    const coordinator = createCoordinator({ transport: source, generation: 1, kind: "p2p" }, () => target)
    await coordinator.connect({ endpointId: "self", mediaIncarnation: "inc_self" })
    await coordinator.beginTransfer(snapshot())
    coordinator.commitSelection(2, [])
    await coordinator.drainSource(2)

    expect(await coordinator.getStats()).toMatchObject({
      directBytesSent: 100,
      directBytesReceived: 80,
      relayBytesSent: 40,
      relayBytesReceived: 30,
    })
  })
})
