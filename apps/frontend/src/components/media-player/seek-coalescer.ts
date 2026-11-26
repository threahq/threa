export interface SeekableMedia {
  currentTime: number
  readonly seeking: boolean
  fastSeek?: (time: number) => void
}

interface SeekRequest {
  time: number
  exact: boolean
}

export interface SeekCoalescer {
  request(time: number, exact: boolean): void
  /** Call when the media element fires `seeked`. */
  seeked(): void
  reset(): void
  /** Time of the seek currently being decoded, or null when none is. */
  readonly inFlight: number | null
  /** Newest requested time that hasn't landed yet, or null when idle. */
  readonly target: number | null
}

export function createSeekCoalescer(media: SeekableMedia): SeekCoalescer {
  let inFlight: SeekRequest | null = null
  let pending: SeekRequest | null = null

  function apply(req: SeekRequest) {
    if (!req.exact && typeof media.fastSeek === "function") media.fastSeek(req.time)
    else media.currentTime = req.time
    // No `seeked` follows a seek the element did not start (no metadata, nothing seekable).
    inFlight = media.seeking ? req : null
  }

  return {
    request(time, exact) {
      const req = { time, exact }
      if (inFlight) pending = req
      else apply(req)
    },
    seeked() {
      const next = pending
      pending = null
      inFlight = null
      if (next) apply(next)
    },
    reset() {
      pending = null
      inFlight = null
    },
    get inFlight() {
      return inFlight?.time ?? null
    },
    get target() {
      return pending?.time ?? inFlight?.time ?? null
    },
  }
}
