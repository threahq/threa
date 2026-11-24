import {
  AUDIO_AAC_BITRATE_PER_CHANNEL,
  AUDIO_INPUT_FORMATS,
  AUDIO_MAX_CHANNELS,
  AUDIO_PCM_SAMPLE_RATE,
  AUDIO_PROBE_TIMEOUT_MS,
  type AudioProbe,
} from "./config"
import { INPUT_PROTOCOLS, runTool, toolFailure, type MediaTools } from "../ffmpeg"

/** Returns null when the input has no audio stream. */
export async function probeAudio(tools: MediaTools, inputUrl: string): Promise<AudioProbe | null> {
  const result = await runTool(
    [
      tools.ffprobePath,
      "-v",
      "error",
      "-protocol_whitelist",
      INPUT_PROTOCOLS,
      "-format_whitelist",
      AUDIO_INPUT_FORMATS,
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,channels:format=format_name",
      "-of",
      "json",
      inputUrl,
    ],
    inputUrl,
    AUDIO_PROBE_TIMEOUT_MS
  )
  if (result.exitCode !== 0) throw toolFailure("ffprobe", result)

  const parsed = JSON.parse(result.stdout) as {
    streams?: { codec_name?: string; channels?: number }[]
    format?: { format_name?: string }
  }
  const stream = parsed.streams?.[0]
  if (!stream?.codec_name) return null
  return {
    codecName: stream.codec_name,
    formatName: parsed.format?.format_name ?? "",
    channels: stream.channels ?? 1,
  }
}

export interface NormalizeParams {
  inputUrl: string
  /** AAC .m4a destination; null decodes PCM only (passthrough). */
  outputPath: string | null
  channels: number
  timeoutMs: number
  onPcm: (chunk: Uint8Array) => void
}

/** One decode pass: the optional AAC output plus mono s16le PCM at {@link AUDIO_PCM_SAMPLE_RATE} on stdout. */
export async function runNormalize(tools: MediaTools, params: NormalizeParams): Promise<void> {
  const channels = Math.max(1, Math.min(AUDIO_MAX_CHANNELS, params.channels))
  const aacOutput = params.outputPath
    ? [
        "-map",
        "0:a:0",
        "-c:a",
        "aac",
        "-ac",
        String(channels),
        "-b:a",
        String(AUDIO_AAC_BITRATE_PER_CHANNEL * channels),
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        params.outputPath,
      ]
    : []
  const result = await runTool(
    [
      tools.ffmpegPath,
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-protocol_whitelist",
      INPUT_PROTOCOLS,
      "-format_whitelist",
      AUDIO_INPUT_FORMATS,
      "-i",
      params.inputUrl,
      ...aacOutput,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      String(AUDIO_PCM_SAMPLE_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ],
    params.inputUrl,
    params.timeoutMs,
    params.onPcm
  )
  if (result.exitCode !== 0) throw toolFailure("ffmpeg", result)
}
