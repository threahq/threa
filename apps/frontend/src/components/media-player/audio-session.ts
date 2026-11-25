import { createContext, createElement, useContext, useEffect, useId, useSyncExternalStore } from "react"
import { registerDecryptedCache } from "@/lib/crypto/decrypted-cache"
import { clampPlaybackRate, loadMediaPreferences, saveMediaPreferences } from "./preferences"

const SEEK_OFFSET_SECONDS = 10

export interface AudioTrack {
  /** Identifies the card the track belongs to; one card per key. */
  key: string
  /** The view that started it; `stopScope` ends playback when that view goes away. Null ends with its card. */
  scope: string | null
  /** A `blob:` URL is owned by the session from here on and revoked once the track is replaced or stopped. */
  src: string
  title: string
}

interface AudioSessionState {
  track: AudioTrack | null
  playbackRate: number
}

// Module-level on purpose: playback must survive the virtualized timeline row that started it unmounting.
let element: HTMLAudioElement | null = null
let state: AudioSessionState | null = null
/** A start whose source is still resolving; cleared once anything else starts or its view goes away. */
let pending: Pick<AudioTrack, "key" | "scope"> | null = null
const listeners = new Set<() => void>()

function getState(): AudioSessionState {
  state ??= { track: null, playbackRate: loadMediaPreferences().playbackRate }
  return state
}

function setState(next: Partial<AudioSessionState>) {
  state = { ...getState(), ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function mediaSession(): MediaSession | null {
  return typeof navigator !== "undefined" && "mediaSession" in navigator ? navigator.mediaSession : null
}

/** A call's remote audio and video are live streams: they neither yield to a track nor take its turn. */
function isLiveStream(media: HTMLMediaElement): boolean {
  return Boolean(media.srcObject)
}

function getElement(): HTMLAudioElement {
  if (element) return element
  const audio = document.createElement("audio")
  audio.preload = "metadata"
  // The element is detached, so a captured `play` always comes from some other media on the page.
  document.addEventListener(
    "play",
    (e) => {
      const other = e.target
      if (other instanceof HTMLMediaElement && other !== audio && !isLiveStream(other) && !audio.paused) audio.pause()
    },
    true
  )
  const session = mediaSession()
  if (session) {
    audio.addEventListener("play", () => (session.playbackState = "playing"))
    audio.addEventListener("pause", () => (session.playbackState = "paused"))
  }
  element = audio
  return audio
}

function play(audio: HTMLAudioElement) {
  for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
    if (media !== audio && !media.paused && !isLiveStream(media)) media.pause()
  }
  // Cards follow the element's own play/pause events, so a refused play simply stays paused.
  void audio.play().catch(() => {})
}

function releaseSrc(src: string) {
  if (src.startsWith("blob:")) URL.revokeObjectURL(src)
}

function bindMediaSession(audio: HTMLAudioElement, track: AudioTrack | null) {
  const session = mediaSession()
  if (!session) return
  if (!track) {
    session.metadata = null
    session.playbackState = "none"
    for (const action of ["play", "pause", "seekto", "seekbackward", "seekforward"] as const) {
      session.setActionHandler(action, null)
    }
    return
  }
  if (typeof MediaMetadata !== "undefined") session.metadata = new MediaMetadata({ title: track.title })
  session.setActionHandler("play", () => play(audio))
  session.setActionHandler("pause", () => audio.pause())
  session.setActionHandler("seekto", (details) => {
    if (details.seekTime !== undefined) audio.currentTime = details.seekTime
  })
  session.setActionHandler("seekbackward", (details) => {
    audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset ?? SEEK_OFFSET_SECONDS))
  })
  session.setActionHandler("seekforward", (details) => {
    audio.currentTime += details.seekOffset ?? SEEK_OFFSET_SECONDS
  })
}

export const audioSession = {
  subscribe,
  getState,

  /** Plays `track` from `startAt` seconds, replacing whatever the session held; resumes when it already holds this key. */
  start(track: AudioTrack, startAt?: number): void {
    pending = null
    const audio = getElement()
    const current = getState().track
    if (current?.key === track.key) {
      if (track.src !== current.src) releaseSrc(track.src)
      if (startAt !== undefined) audio.currentTime = startAt
      play(audio)
      return
    }
    audio.pause()
    // The video player shares the stored rate, so it may have moved since the session last read it.
    const { playbackRate } = loadMediaPreferences()
    audio.src = track.src
    audio.defaultPlaybackRate = playbackRate
    audio.playbackRate = playbackRate
    if (startAt !== undefined) audio.currentTime = startAt
    setState({ track, playbackRate })
    if (current) releaseSrc(current.src)
    bindMediaSession(audio, track)
    play(audio)
  },

  /**
   * For a source that takes time to resolve. The returned function starts the track with it, unless another
   * track started or this one's view went away meanwhile: then it only releases the source.
   */
  prepare(track: Omit<AudioTrack, "src">, startAt?: number): (src: string) => void {
    const request = { key: track.key, scope: track.scope }
    pending = request
    return (src) => {
      if (pending !== request) return releaseSrc(src)
      audioSession.start({ ...track, src }, startAt)
    }
  },

  /** Resumes the held track, pausing any other media on the page. */
  resume(): void {
    if (!getState().track) return
    pending = null
    play(getElement())
  },

  stop(): void {
    const current = getState().track
    if (!current) return
    const audio = getElement()
    audio.pause()
    audio.removeAttribute("src")
    audio.load()
    setState({ track: null })
    releaseSrc(current.src)
    bindMediaSession(audio, null)
  },

  stopScope(scope: string): void {
    if (pending?.scope === scope) pending = null
    if (getState().track?.scope === scope) audioSession.stop()
  },

  /** Ends the track a card started outside any scope; a scoped track with the same key belongs to its view. */
  stopUnscoped(key: string): void {
    if (pending?.key === key && pending.scope === null) pending = null
    const current = getState().track
    if (current?.key === key && current.scope === null) audioSession.stop()
  },

  setPlaybackRate(rate: number): void {
    const next = clampPlaybackRate(rate)
    const audio = getElement()
    audio.defaultPlaybackRate = next
    audio.playbackRate = next
    saveMediaPreferences({ ...loadMediaPreferences(), playbackRate: next })
    setState({ playbackRate: next })
  },
}

// A `blob:` source is decrypted audio, and only a decrypt is ever pending: both end when the E2EE session locks.
registerDecryptedCache(() => {
  pending = null
  if (getState().track?.src.startsWith("blob:")) audioSession.stop()
})

/** The session's element while it holds `key`, otherwise null: the card binds its playback state to it. */
export function useAudioSessionElement(key: string): HTMLAudioElement | null {
  const active = useSyncExternalStore(
    subscribe,
    () => getState().track?.key === key,
    () => false
  )
  return active ? getElement() : null
}

export function useAudioPlaybackRate(): number {
  return useSyncExternalStore(
    subscribe,
    () => getState().playbackRate,
    () => getState().playbackRate
  )
}

const AudioScopeContext = createContext<string | null>(null)

export function useAudioScopeId(): string | null {
  return useContext(AudioScopeContext)
}

/**
 * Audio started inside stops when this view unmounts or its `scope` changes; a row scrolling away does not.
 * Two mounted views of the same `scope` stay separate, so closing one leaves the other's audio playing.
 */
export function AudioScope({ scope, children }: { scope: string; children: React.ReactNode }) {
  const id = `${useId()}:${scope}`
  useEffect(() => () => audioSession.stopScope(id), [id])
  return createElement(AudioScopeContext.Provider, { value: id }, children)
}
