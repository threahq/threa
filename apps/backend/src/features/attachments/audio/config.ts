import { derivedStoragePath } from "../derived-storage"

export const AUDIO_WAVEFORM_BUCKETS = 200
export const AUDIO_PCM_SAMPLE_RATE = 8000
export const AUDIO_PROCESS_TIMEOUT_MS = 20 * 60 * 1000
export const AUDIO_PROBE_TIMEOUT_MS = 2 * 60 * 1000
/** Outlives the process timeout: ffmpeg keeps issuing ranged requests against the URL for the whole run. */
export const AUDIO_SOURCE_URL_EXPIRES_SECONDS = 60 * 60
export const AUDIO_AAC_BITRATE_PER_CHANNEL = 64_000
export const AUDIO_MAX_CHANNELS = 2
/** Demuxers ffmpeg may use. Playlist formats (hls, concat, dash) are left out: they make ffmpeg fetch URLs named inside the upload. */
export const AUDIO_INPUT_FORMATS = "mp3,mov,aac,wav,w64,flac,ogg,aiff,asf,amr,caf,matroska"
export const AUDIO_NORMALIZED_EXTENSION = "m4a"
export const AUDIO_NORMALIZED_FILENAME = `normalized.${AUDIO_NORMALIZED_EXTENSION}`
export const AUDIO_NORMALIZED_MIME_TYPE = "audio/mp4"

export interface AudioProbe {
  codecName: string
  formatName: string
  channels: number
}

/** Browsers play mp3 files and AAC in mp4 natively, so those keep the original as the playable form. */
export function isPassthroughAudio(probe: AudioProbe): boolean {
  const formats = probe.formatName.split(",")
  if (probe.codecName === "mp3") return formats.includes("mp3")
  if (probe.codecName === "aac") return formats.includes("mp4")
  return false
}

export function normalizedAudioStoragePath(workspaceId: string, attachmentId: string): string {
  return derivedStoragePath(workspaceId, attachmentId, AUDIO_NORMALIZED_FILENAME)
}
