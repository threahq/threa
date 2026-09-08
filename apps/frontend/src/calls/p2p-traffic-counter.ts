export type P2pTrafficPath = {
  pairId: string | null
  kind: "direct" | "relay" | null
}

export type P2pTrafficInterval = {
  bytesSent: number
  bytesReceived: number
  packetsReceived: number
  packetsLost: number
}

export type P2pTrafficTotals = {
  directBytesSent: number
  directBytesReceived: number
  relayBytesSent: number
  relayBytesReceived: number
  unknownBytesSent: number
  unknownBytesReceived: number
}

type CounterSample = {
  bytes: number
  timestamp: number | null
}

type PeerSample = {
  counters: Map<string, CounterSample>
  packetCounters: Map<string, { received: number; lost: number; timestamp: number | null }>
  path: P2pTrafficPath
  latestTimestamp: number | null
}

const emptyTotals = (): P2pTrafficTotals => ({
  directBytesSent: 0,
  directBytesReceived: 0,
  relayBytesSent: 0,
  relayBytesReceived: 0,
  unknownBytesSent: 0,
  unknownBytesReceived: 0,
})

export class P2pTrafficCounter {
  private readonly samples = new Map<symbol, PeerSample>()
  private readonly cumulative = emptyTotals()

  get totals(): P2pTrafficTotals {
    return { ...this.cumulative }
  }

  observe(key: symbol, report: RTCStatsReport, path: P2pTrafficPath): P2pTrafficInterval {
    const previous = this.samples.get(key)
    const observed: Array<{ id: string; direction: "sent" | "received"; bytes: number; timestamp: number | null }> = []
    const observedPackets: Array<{ id: string; received: number; lost: number; timestamp: number | null }> = []
    let latestTimestamp: number | null = null

    report.forEach((value) => {
      const stat = value as Record<string, unknown>
      const timestamp = typeof stat.timestamp === "number" && Number.isFinite(stat.timestamp) ? stat.timestamp : null
      if (timestamp !== null) latestTimestamp = Math.max(latestTimestamp ?? timestamp, timestamp)

      if (stat.type === "outbound-rtp" && typeof stat.id === "string" && isByteCounter(stat.bytesSent)) {
        observed.push({ id: stat.id, direction: "sent", bytes: stat.bytesSent, timestamp })
      }
      if (stat.type === "inbound-rtp" && typeof stat.id === "string") {
        if (isByteCounter(stat.bytesReceived)) {
          observed.push({ id: stat.id, direction: "received", bytes: stat.bytesReceived, timestamp })
        }
        if (
          isPacketCounter(stat.packetsReceived) &&
          typeof stat.packetsLost === "number" &&
          Number.isInteger(stat.packetsLost)
        ) {
          observedPackets.push({ id: stat.id, received: stat.packetsReceived, lost: stat.packetsLost, timestamp })
        }
      }
    })

    if (
      previous?.latestTimestamp !== null &&
      previous?.latestTimestamp !== undefined &&
      latestTimestamp !== null &&
      latestTimestamp < previous.latestTimestamp
    ) {
      return { bytesSent: 0, bytesReceived: 0, packetsReceived: 0, packetsLost: 0 }
    }

    const counters = previous?.counters ?? new Map<string, CounterSample>()
    const packetCounters = previous?.packetCounters ?? new Map()
    let bytesSent = 0
    let bytesReceived = 0
    let firstBytesSent = 0
    let firstBytesReceived = 0
    let packetsReceived = 0
    let packetsLost = 0

    for (const current of observed) {
      const counterKey = `${current.direction}:${current.id}`
      const prior = counters.get(counterKey)
      if (
        prior?.timestamp !== null &&
        prior?.timestamp !== undefined &&
        current.timestamp !== null &&
        current.timestamp < prior.timestamp
      ) {
        continue
      }

      const delta = prior && current.bytes >= prior.bytes ? current.bytes - prior.bytes : current.bytes
      if (current.direction === "sent") {
        bytesSent += delta
        if (!prior) firstBytesSent += delta
      } else {
        bytesReceived += delta
        if (!prior) firstBytesReceived += delta
      }
      counters.set(counterKey, { bytes: current.bytes, timestamp: current.timestamp })
    }

    for (const current of observedPackets) {
      const prior = packetCounters.get(current.id)
      if (prior?.timestamp != null && current.timestamp != null && current.timestamp < prior.timestamp) continue
      if (prior) {
        // Late or duplicate packets can reduce cumulative loss without resetting reception.
        const reset = current.received < prior.received
        packetsReceived += reset ? current.received : current.received - prior.received
        packetsLost += Math.max(0, reset ? current.lost : current.lost - prior.lost)
      }
      packetCounters.set(current.id, {
        received: current.received,
        lost: current.lost,
        timestamp: current.timestamp,
      })
    }

    const stableKnownPath =
      previous !== undefined &&
      previous.path.pairId !== null &&
      previous.path.kind !== null &&
      previous.path.pairId === path.pairId &&
      previous.path.kind === path.kind
    const classification = stableKnownPath && path.kind !== null ? path.kind : "unknown"
    this.add(classification, bytesSent - firstBytesSent, bytesReceived - firstBytesReceived)
    this.add("unknown", firstBytesSent, firstBytesReceived)
    this.samples.set(key, {
      counters,
      packetCounters,
      path: { ...path },
      latestTimestamp: latestTimestamp ?? previous?.latestTimestamp ?? null,
    })

    return { bytesSent, bytesReceived, packetsReceived, packetsLost }
  }

  forget(key: symbol): void {
    this.samples.delete(key)
  }

  private add(kind: "direct" | "relay" | "unknown", bytesSent: number, bytesReceived: number): void {
    if (kind === "direct") {
      this.cumulative.directBytesSent += bytesSent
      this.cumulative.directBytesReceived += bytesReceived
    } else if (kind === "relay") {
      this.cumulative.relayBytesSent += bytesSent
      this.cumulative.relayBytesReceived += bytesReceived
    } else {
      this.cumulative.unknownBytesSent += bytesSent
      this.cumulative.unknownBytesReceived += bytesReceived
    }
  }
}

function isByteCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function isPacketCounter(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}
