import { clamp } from "@/lib/math-utils"

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

export interface MediaPreferences {
  playbackRate: number
  volume: number
  muted: boolean
}

export const DEFAULT_MEDIA_PREFERENCES: MediaPreferences = { playbackRate: 1, volume: 1, muted: false }

export function formatPlaybackRate(rate: number): string {
  return `${rate}×`
}

const STORAGE_KEY = "threa:media-player:preferences"

export function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return DEFAULT_MEDIA_PREFERENCES.playbackRate
  let nearest: number = PLAYBACK_RATES[0]
  for (const offered of PLAYBACK_RATES) {
    if (Math.abs(offered - rate) < Math.abs(nearest - rate)) nearest = offered
  }
  return nearest
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_MEDIA_PREFERENCES.volume
  return clamp(volume, 0, 1)
}

export function loadMediaPreferences(): MediaPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_MEDIA_PREFERENCES
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_MEDIA_PREFERENCES
    const stored = parsed as Partial<Record<keyof MediaPreferences, unknown>>
    return {
      playbackRate:
        typeof stored.playbackRate === "number"
          ? clampPlaybackRate(stored.playbackRate)
          : DEFAULT_MEDIA_PREFERENCES.playbackRate,
      volume: typeof stored.volume === "number" ? clampVolume(stored.volume) : DEFAULT_MEDIA_PREFERENCES.volume,
      muted: typeof stored.muted === "boolean" ? stored.muted : DEFAULT_MEDIA_PREFERENCES.muted,
    }
  } catch {
    return DEFAULT_MEDIA_PREFERENCES
  }
}

export function saveMediaPreferences(prefs: MediaPreferences): void {
  const normalized: MediaPreferences = {
    playbackRate: clampPlaybackRate(prefs.playbackRate),
    volume: clampVolume(prefs.volume),
    muted: prefs.muted,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // Quota / private-mode failures leave the in-session preference in place.
  }
}
