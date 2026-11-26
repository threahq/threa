import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { clamp } from "@/lib/math-utils"
import { createSeekCoalescer, type SeekCoalescer } from "./seek-coalescer"
import { NUDGE_CHAIN_MS, nextNudgeChain, type NudgeChain, type NudgeDirection } from "./gestures"
import { PLAYBACK_RATES, clampPlaybackRate, loadMediaPreferences, saveMediaPreferences } from "./preferences"

const BUSY_DELAY_MS = 200
const FRAME_SECONDS = 1 / 30

export interface BufferedRange {
  start: number
  end: number
}

export interface MediaPlayback {
  paused: boolean
  /** True once playback has been started at least once. */
  started: boolean
  /** Displayed position: follows a scrub or pending seek before the element lands. */
  time: number
  duration: number
  buffered: BufferedRange[]
  /** Waiting or seeking for longer than BUSY_DELAY_MS. */
  busy: boolean
  /** The source cannot be loaded or decoded. */
  failed: boolean
  scrubbing: boolean
  muted: boolean
  volume: number
  playbackRate: number
  /** Last nudge chain; `nudgeVisible` drops NUDGE_CHAIN_MS after its last nudge. */
  nudge: NudgeChain | null
  nudgeVisible: boolean
  togglePlay(): void
  seek(time: number): void
  seekFraction(fraction: number): void
  nudgeBy(direction: NudgeDirection, seconds: number): void
  stepFrame(direction: NudgeDirection): void
  beginScrub(): void
  scrubTo(time: number): void
  endScrub(): void
  setPlaybackRate(rate: number): void
  stepPlaybackRate(direction: NudgeDirection): void
  setVolume(volume: number): void
  toggleMute(): void
}

function finiteDuration(media: HTMLMediaElement): number {
  return Number.isFinite(media.duration) ? media.duration : 0
}

function readBuffered(media: HTMLMediaElement): BufferedRange[] {
  const ranges: BufferedRange[] = []
  const { buffered } = media
  if (!buffered) return ranges
  for (let i = 0; i < buffered.length; i++) ranges.push({ start: buffered.start(i), end: buffered.end(i) })
  return ranges
}

function startPlayback(media: HTMLMediaElement) {
  // State follows the element's own play/pause events, so a refused play simply stays paused.
  void media.play().catch(() => {})
}

export function useMediaPlayback(media: HTMLMediaElement | null): MediaPlayback {
  const [prefs] = useState(loadMediaPreferences)
  const [paused, setPaused] = useState(true)
  const [started, setStarted] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<BufferedRange[]>([])
  const [rawBusy, setRawBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [scrubTime, setScrubTime] = useState<number | null>(null)
  const [seekTarget, setSeekTarget] = useState<number | null>(null)
  const [muted, setMuted] = useState(prefs.muted)
  const [volume, setVolumeState] = useState(prefs.volume)
  const [playbackRate, setRateState] = useState(prefs.playbackRate)
  const [nudge, setNudge] = useState<NudgeChain | null>(null)
  const [nudgeVisible, setNudgeVisible] = useState(false)

  const coalescerRef = useRef<SeekCoalescer | null>(null)
  const resumeAfterScrubRef = useRef(false)
  const scrubTimeRef = useRef<number | null>(null)
  const nudgeRef = useRef<NudgeChain | null>(null)
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!media) return
    media.defaultPlaybackRate = prefs.playbackRate
    media.playbackRate = prefs.playbackRate
    media.volume = prefs.volume
    media.muted = prefs.muted
    const coalescer = createSeekCoalescer(media)
    coalescerRef.current = coalescer

    const syncTime = () => {
      setCurrentTime(media.currentTime)
      setDuration(finiteDuration(media))
      setBuffered(readBuffered(media))
    }
    const syncSeeking = () => setRawBusy(media.seeking || (media.readyState < 3 && !media.paused))
    const onPlay = () => {
      setPaused(false)
      setStarted(true)
    }
    const onPause = () => setPaused(true)
    const onSeeked = () => {
      coalescer.seeked()
      setSeekTarget(coalescer.target)
      syncTime()
      syncSeeking()
    }
    const onWaiting = () => setRawBusy(true)
    const onReady = () => syncSeeking()
    const onVolume = () => {
      setMuted(media.muted)
      setVolumeState(media.volume)
    }
    const onRate = () => setRateState(media.playbackRate)
    // Neither a source swap nor a load failure fires `pause` or `seeked`.
    const resyncElementState = () => {
      coalescer.reset()
      setSeekTarget(null)
      setPaused(media.paused)
      syncSeeking()
    }
    const onEmptied = () => {
      setFailed(false)
      resyncElementState()
    }
    const onError = () => {
      setFailed(true)
      resyncElementState()
    }

    const listeners: Array<[string, () => void]> = [
      ["play", onPlay],
      ["pause", onPause],
      ["timeupdate", syncTime],
      ["durationchange", syncTime],
      ["loadedmetadata", syncTime],
      ["progress", syncTime],
      ["seeking", syncSeeking],
      ["seeked", onSeeked],
      ["waiting", onWaiting],
      ["playing", onReady],
      ["canplay", onReady],
      ["volumechange", onVolume],
      ["ratechange", onRate],
      ["emptied", onEmptied],
      ["error", onError],
    ]
    for (const [type, fn] of listeners) media.addEventListener(type, fn)
    syncTime()
    return () => {
      for (const [type, fn] of listeners) media.removeEventListener(type, fn)
      coalescerRef.current = null
      if (!media.paused) media.pause()
    }
  }, [media, prefs])

  useEffect(() => {
    if (!media || paused) return
    let frame = requestAnimationFrame(function tick() {
      setCurrentTime(media.currentTime)
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [media, paused])

  useEffect(() => {
    if (!rawBusy) {
      setBusy(false)
      return
    }
    const timer = setTimeout(() => setBusy(true), BUSY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [rawBusy])

  useEffect(
    () => () => {
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current)
    },
    []
  )

  const requestSeek = useCallback(
    (time: number, exact: boolean) => {
      const coalescer = coalescerRef.current
      if (!media || !coalescer) return
      const clamped = clamp(time, 0, finiteDuration(media) || Math.max(0, time))
      coalescer.request(clamped, exact)
      setSeekTarget(coalescer.target)
      setCurrentTime(media.currentTime)
    },
    [media]
  )

  const basePosition = useCallback(
    () => scrubTimeRef.current ?? coalescerRef.current?.target ?? media?.currentTime ?? 0,
    [media]
  )

  const persist = useCallback(
    (next: Partial<{ playbackRate: number; volume: number; muted: boolean }>) => {
      if (!media) return
      saveMediaPreferences({
        playbackRate: next.playbackRate ?? media.playbackRate,
        volume: next.volume ?? media.volume,
        muted: next.muted ?? media.muted,
      })
    },
    [media]
  )

  const togglePlay = useCallback(() => {
    if (!media) return
    if (media.paused) startPlayback(media)
    else media.pause()
  }, [media])

  const seek = useCallback((time: number) => requestSeek(time, true), [requestSeek])

  const seekFraction = useCallback(
    (fraction: number) => {
      if (media) requestSeek(finiteDuration(media) * fraction, true)
    },
    [media, requestSeek]
  )

  const nudgeBy = useCallback(
    (direction: NudgeDirection, seconds: number) => {
      const chain = nextNudgeChain(nudgeRef.current, direction, seconds, Date.now())
      nudgeRef.current = chain
      setNudge(chain)
      setNudgeVisible(true)
      if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current)
      nudgeTimerRef.current = setTimeout(() => setNudgeVisible(false), NUDGE_CHAIN_MS)
      requestSeek(basePosition() + direction * seconds, true)
    },
    [basePosition, requestSeek]
  )

  const stepFrame = useCallback(
    (direction: NudgeDirection) => {
      if (!media?.paused) return
      requestSeek(basePosition() + direction * FRAME_SECONDS, true)
    },
    [media, basePosition, requestSeek]
  )

  const beginScrub = useCallback(() => {
    if (!media || scrubTimeRef.current !== null) return
    resumeAfterScrubRef.current = !media.paused
    if (!media.paused) media.pause()
    scrubTimeRef.current = media.currentTime
    setScrubTime(media.currentTime)
  }, [media])

  const scrubTo = useCallback(
    (time: number) => {
      if (scrubTimeRef.current === null) return
      scrubTimeRef.current = time
      setScrubTime(time)
      requestSeek(time, false)
    },
    [requestSeek]
  )

  const endScrub = useCallback(() => {
    const time = scrubTimeRef.current
    if (!media || time === null) return
    scrubTimeRef.current = null
    setScrubTime(null)
    requestSeek(time, true)
    if (resumeAfterScrubRef.current) startPlayback(media)
    resumeAfterScrubRef.current = false
  }, [media, requestSeek])

  const setPlaybackRate = useCallback(
    (rate: number) => {
      if (!media) return
      const next = clampPlaybackRate(rate)
      media.defaultPlaybackRate = next
      media.playbackRate = next
      persist({ playbackRate: next })
    },
    [media, persist]
  )

  const stepPlaybackRate = useCallback(
    (direction: NudgeDirection) => {
      const index = PLAYBACK_RATES.indexOf(clampPlaybackRate(playbackRate) as (typeof PLAYBACK_RATES)[number])
      const next = PLAYBACK_RATES[clamp(index + direction, 0, PLAYBACK_RATES.length - 1)]
      setPlaybackRate(next)
    },
    [playbackRate, setPlaybackRate]
  )

  const setVolume = useCallback(
    (next: number) => {
      if (!media) return
      const clamped = clamp(next, 0, 1)
      media.volume = clamped
      media.muted = clamped === 0
      persist({ volume: clamped, muted: clamped === 0 })
    },
    [media, persist]
  )

  const toggleMute = useCallback(() => {
    if (!media) return
    if (media.muted || media.volume === 0) {
      const restored = media.volume === 0 ? 1 : media.volume
      media.volume = restored
      media.muted = false
      persist({ volume: restored, muted: false })
    } else {
      media.muted = true
      persist({ muted: true })
    }
  }, [media, persist])

  const time = scrubTime ?? seekTarget ?? currentTime

  return useMemo(
    () => ({
      paused,
      started,
      time,
      duration,
      buffered,
      busy,
      failed,
      scrubbing: scrubTime !== null,
      muted,
      volume,
      playbackRate,
      nudge,
      nudgeVisible,
      togglePlay,
      seek,
      seekFraction,
      nudgeBy,
      stepFrame,
      beginScrub,
      scrubTo,
      endScrub,
      setPlaybackRate,
      stepPlaybackRate,
      setVolume,
      toggleMute,
    }),
    [
      paused,
      started,
      time,
      duration,
      buffered,
      busy,
      failed,
      scrubTime,
      muted,
      volume,
      playbackRate,
      nudge,
      nudgeVisible,
      togglePlay,
      seek,
      seekFraction,
      nudgeBy,
      stepFrame,
      beginScrub,
      scrubTo,
      endScrub,
      setPlaybackRate,
      stepPlaybackRate,
      setVolume,
      toggleMute,
    ]
  )
}
