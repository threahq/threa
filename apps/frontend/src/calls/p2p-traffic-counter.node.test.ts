import { describe, expect, it } from "vitest"
import { P2pTrafficCounter } from "./p2p-traffic-counter"

const path = (pairId: string | null, kind: "direct" | "relay" | null) => ({ pairId, kind })

function report(...stats: Array<Record<string, unknown>>): RTCStatsReport {
  return new Map(stats.map((stat) => [String(stat.id), stat])) as unknown as RTCStatsReport
}

function outbound(id: string, bytesSent: number, timestamp: number) {
  return { id, type: "outbound-rtp", bytesSent, timestamp }
}

function inbound(id: string, bytesReceived: number, timestamp: number) {
  return { id, type: "inbound-rtp", bytesReceived, timestamp }
}

describe("P2pTrafficCounter", () => {
  it("should include first observed RTP counters without attributing their history to the current path", () => {
    const counter = new P2pTrafficCounter()

    expect(
      counter.observe(Symbol(), report(outbound("video", 100, 1), inbound("audio", 80, 1)), path("pair", "direct"))
    ).toEqual({
      bytesSent: 100,
      bytesReceived: 80,
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(counter.totals).toEqual({
      directBytesSent: 0,
      directBytesReceived: 0,
      relayBytesSent: 0,
      relayBytesReceived: 0,
      unknownBytesSent: 100,
      unknownBytesReceived: 80,
    })
  })

  it("should assign stable-path deltas to that path", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    counter.observe(key, report(outbound("out", 10, 1), inbound("in", 20, 1)), path("pair", "relay"))

    expect(counter.observe(key, report(outbound("out", 15, 2), inbound("in", 27, 2)), path("pair", "relay"))).toEqual({
      bytesSent: 5,
      bytesReceived: 7,
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(counter.totals).toEqual({
      directBytesSent: 0,
      directBytesReceived: 0,
      relayBytesSent: 5,
      relayBytesReceived: 7,
      unknownBytesSent: 10,
      unknownBytesReceived: 20,
    })
  })

  it.each([
    {
      name: "candidate pair changes while sent bytes advance",
      nextPath: path("other", "direct"),
      nextReport: report(outbound("out", 15, 2), inbound("in", 20, 2)),
      unknownBytesSent: 5,
      unknownBytesReceived: 0,
    },
    {
      name: "path kind changes while received bytes advance",
      nextPath: path("pair", "relay"),
      nextReport: report(outbound("out", 10, 2), inbound("in", 27, 2)),
      unknownBytesSent: 0,
      unknownBytesReceived: 7,
    },
  ])(
    "should assign the interval to unknown when $name",
    ({ nextPath, nextReport, unknownBytesSent, unknownBytesReceived }) => {
      const counter = new P2pTrafficCounter()
      const key = Symbol()
      counter.observe(key, report(outbound("out", 10, 1), inbound("in", 20, 1)), path("pair", "direct"))

      counter.observe(key, nextReport, nextPath)

      expect(counter.totals).toEqual({
        directBytesSent: 0,
        directBytesReceived: 0,
        relayBytesSent: 0,
        relayBytesReceived: 0,
        unknownBytesSent: 10 + unknownBytesSent,
        unknownBytesReceived: 20 + unknownBytesReceived,
      })
    }
  )

  it("should not reclassify bytes observed before a path becomes known", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    counter.observe(key, report(outbound("out", 10, 1), inbound("in", 20, 1)), path(null, null))
    counter.observe(key, report(outbound("out", 15, 2), inbound("in", 25, 2)), path("pair", "direct"))
    counter.observe(key, report(outbound("out", 18, 3), inbound("in", 29, 3)), path("pair", "direct"))

    expect(counter.totals).toEqual({
      directBytesSent: 3,
      directBytesReceived: 4,
      relayBytesSent: 0,
      relayBytesReceived: 0,
      unknownBytesSent: 15,
      unknownBytesReceived: 25,
    })
  })

  it("should count each RTP counter independently when one resets", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    counter.observe(key, report(outbound("mic", 100, 1), outbound("video", 1_000, 1)), path("pair", "direct"))

    expect(
      counter.observe(key, report(outbound("mic", 5, 2), outbound("video", 1_100, 2)), path("pair", "direct"))
    ).toEqual({
      bytesSent: 105,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
    })
  })

  it("should include newly observed RTP stat IDs", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    counter.observe(key, report(outbound("mic", 10, 1)), path("pair", "direct"))

    expect(
      counter.observe(key, report(outbound("mic", 12, 2), outbound("video", 50, 2)), path("pair", "direct"))
    ).toEqual({
      bytesSent: 52,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
    })
  })

  it("should ignore older snapshots instead of treating them as resets", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    counter.observe(key, report(outbound("out", 100, 20)), path("pair", "direct"))

    expect(counter.observe(key, report(outbound("out", 80, 10)), path("pair", "relay"))).toEqual({
      bytesSent: 0,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(counter.observe(key, report(outbound("out", 110, 30)), path("pair", "direct"))).toEqual({
      bytesSent: 10,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(counter.totals).toEqual({
      directBytesSent: 10,
      directBytesReceived: 0,
      relayBytesSent: 0,
      relayBytesReceived: 0,
      unknownBytesSent: 100,
      unknownBytesReceived: 0,
    })
  })

  it("should isolate a new peer token that reuses an endpoint", () => {
    const counter = new P2pTrafficCounter()
    counter.observe(Symbol("old"), report(outbound("out", 100, 1)), path("pair", "direct"))

    expect(counter.observe(Symbol("new"), report(outbound("out", 7, 2)), path("pair", "direct"))).toEqual({
      bytesSent: 7,
      bytesReceived: 0,
      packetsReceived: 0,
      packetsLost: 0,
    })
  })

  it("should calculate packet loss from reset-safe intervals across RTP identities", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    const inboundPackets = (id: string, received: number, lost: number, timestamp: number) => ({
      id,
      type: "inbound-rtp",
      bytesReceived: received,
      packetsReceived: received,
      packetsLost: lost,
      timestamp,
    })

    expect(counter.observe(key, report(inboundPackets("video", 1_000, 100, 1)), path("pair", "direct"))).toMatchObject({
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(counter.observe(key, report(inboundPackets("video", 1_100, 100, 2)), path("pair", "direct"))).toMatchObject({
      packetsReceived: 100,
      packetsLost: 0,
    })
    expect(counter.observe(key, report(inboundPackets("video", 1_110, 110, 3)), path("pair", "direct"))).toMatchObject({
      packetsReceived: 10,
      packetsLost: 10,
    })
    expect(counter.observe(key, report(inboundPackets("video", 5, 2, 4)), path("pair", "direct"))).toMatchObject({
      packetsReceived: 5,
      packetsLost: 2,
    })
  })

  it("should combine packet deltas for multiple SSRCs and ignore stale samples", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    const packets = (id: string, received: number, lost: number, timestamp: number) => ({
      id,
      type: "inbound-rtp",
      bytesReceived: received,
      packetsReceived: received,
      packetsLost: lost,
      timestamp,
    })
    counter.observe(key, report(packets("audio", 100, 0, 10), packets("video", 200, 10, 10)), path("pair", "direct"))

    expect(
      counter.observe(key, report(packets("audio", 110, 1, 20), packets("video", 220, 14, 20)), path("pair", "direct"))
    ).toMatchObject({ packetsReceived: 30, packetsLost: 5 })
    expect(counter.observe(key, report(packets("audio", 105, 0, 15)), path("pair", "direct"))).toMatchObject({
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(
      counter.observe(key, report(packets("audio", 120, 1, 30), packets("video", 230, 14, 30)), path("pair", "direct"))
    ).toMatchObject({ packetsReceived: 20, packetsLost: 0 })
  })

  it("should baseline a newly observed RTP identity without counting its historical loss", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    const packets = (id: string, received: number, lost: number, timestamp: number) => ({
      ...inbound(id, received, timestamp),
      packetsReceived: received,
      packetsLost: lost,
    })
    counter.observe(key, report(packets("audio", 100, 0, 1)), path("pair", "direct"))
    const firstVideo = counter.observe(
      key,
      report(packets("audio", 110, 0, 2), packets("video", 9000, 900, 2)),
      path("pair", "direct")
    )
    const next = counter.observe(
      key,
      report(packets("audio", 120, 0, 3), packets("video", 9020, 901, 3)),
      path("pair", "direct")
    )
    expect([firstVideo, next]).toMatchObject([
      { packetsReceived: 10, packetsLost: 0 },
      { packetsReceived: 30, packetsLost: 1 },
    ])
    expect(counter.totals).toMatchObject({ directBytesReceived: 40, unknownBytesReceived: 9100 })
  })

  it.each([
    { previousLost: 5, currentLost: 3, expectedLost: 0 },
    { previousLost: -2, currentLost: 2, expectedLost: 4 },
  ])(
    "should handle signed cumulative loss from $previousLost to $currentLost",
    ({ previousLost, currentLost, expectedLost }) => {
      const counter = new P2pTrafficCounter()
      const key = Symbol()
      counter.observe(
        key,
        report({ ...inbound("audio", 100, 1), packetsReceived: 100, packetsLost: previousLost }),
        path("pair", "direct")
      )
      expect(
        counter.observe(
          key,
          report({ ...inbound("audio", 110, 2), packetsReceived: 110, packetsLost: currentLost }),
          path("pair", "direct")
        )
      ).toMatchObject({ packetsReceived: 10, packetsLost: expectedLost })
    }
  )

  it("should forget sampling state without clearing cumulative totals", () => {
    const counter = new P2pTrafficCounter()
    const key = Symbol()
    counter.observe(key, report(inbound("in", 40, 1)), path("pair", "relay"))
    counter.forget(key)

    expect(counter.observe(key, report(inbound("in", 5, 2)), path("pair", "relay"))).toEqual({
      bytesSent: 0,
      bytesReceived: 5,
      packetsReceived: 0,
      packetsLost: 0,
    })
    expect(counter.totals.unknownBytesReceived).toBe(45)
  })
})
