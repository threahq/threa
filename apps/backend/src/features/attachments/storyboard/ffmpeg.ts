import { INPUT_PROTOCOLS, UndecodableMediaError, runTool, toolFailure, type MediaTools } from "../ffmpeg"
import {
  STORYBOARD_INPUT_FORMATS,
  STORYBOARD_JPEG_QUALITY,
  STORYBOARD_MAX_SOURCE_PIXELS,
  STORYBOARD_PROBE_TIMEOUT_MS,
  STORYBOARD_SPRITE_TIMEOUT_MS,
  STORYBOARD_TILE_MAX_HEIGHT,
  STORYBOARD_TILE_MAX_WIDTH,
} from "./config"

const UNTRUSTED_INPUT = ["-protocol_whitelist", INPUT_PROTOCOLS, "-format_whitelist", STORYBOARD_INPUT_FORMATS]
const LOCAL_INPUT = ["-protocol_whitelist", "file"]
const FFMPEG_FLAGS = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
/** ffmpeg's exit message when the seek landed after the last video frame: audio outlasting the picture, or sparse frames. */
const NO_FRAME_STDERR = /Nothing was written into output file/

/** Returns null when the input has no video stream or no positive duration. */
export async function probeVideoDurationMs(tools: MediaTools, inputUrl: string): Promise<number | null> {
  const result = await runTool(
    [
      tools.ffprobePath,
      "-v",
      "error",
      ...UNTRUSTED_INPUT,
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_type,duration:format=duration",
      "-of",
      "json",
      inputUrl,
    ],
    inputUrl,
    STORYBOARD_PROBE_TIMEOUT_MS
  )
  if (result.exitCode !== 0) throw toolFailure("ffprobe", result)

  const parsed = JSON.parse(result.stdout) as {
    streams?: { codec_type?: string; duration?: string }[]
    format?: { duration?: string }
  }
  const stream = parsed.streams?.[0]
  if (stream?.codec_type !== "video") return null
  const seconds = Number(parsed.format?.duration ?? stream.duration)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return Math.round(seconds * 1000)
}

/** Seeks over ranged HTTP and writes the first frame at or after `seconds`, scaled; writes nothing when there is none. */
export async function grabTile(
  tools: MediaTools,
  params: { inputUrl: string; seconds: number; outputPath: string; timeoutMs: number }
): Promise<void> {
  const result = await runTool(
    [
      tools.ffmpegPath,
      ...FFMPEG_FLAGS,
      ...UNTRUSTED_INPUT,
      "-max_pixels",
      String(STORYBOARD_MAX_SOURCE_PIXELS),
      "-ss",
      params.seconds.toFixed(3),
      "-i",
      params.inputUrl,
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-vf",
      `scale=w=${STORYBOARD_TILE_MAX_WIDTH}:h=${STORYBOARD_TILE_MAX_HEIGHT}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      "-q:v",
      String(STORYBOARD_JPEG_QUALITY),
      params.outputPath,
    ],
    params.inputUrl,
    params.timeoutMs
  )
  if (result.exitCode === 0) return
  const failure = toolFailure("ffmpeg", result)
  if (failure instanceof UndecodableMediaError || !NO_FRAME_STDERR.test(result.stderrTail)) throw failure
}

/** Tiles the numbered frames matching `tilePattern` into one sprite, row-major. */
export async function tileSprite(
  tools: MediaTools,
  params: { tilePattern: string; columns: number; rows: number; outputPath: string }
): Promise<void> {
  const result = await runTool(
    [
      tools.ffmpegPath,
      ...FFMPEG_FLAGS,
      ...LOCAL_INPUT,
      "-f",
      "image2",
      "-i",
      params.tilePattern,
      "-vf",
      `tile=${params.columns}x${params.rows}`,
      "-frames:v",
      "1",
      "-q:v",
      String(STORYBOARD_JPEG_QUALITY),
      params.outputPath,
    ],
    params.tilePattern,
    STORYBOARD_SPRITE_TIMEOUT_MS
  )
  if (result.exitCode !== 0) throw toolFailure("ffmpeg", result)
}

export async function probeImageSize(tools: MediaTools, path: string): Promise<{ width: number; height: number }> {
  const result = await runTool(
    [tools.ffprobePath, "-v", "error", ...LOCAL_INPUT, "-show_entries", "stream=width,height", "-of", "json", path],
    path,
    STORYBOARD_PROBE_TIMEOUT_MS
  )
  if (result.exitCode !== 0) throw toolFailure("ffprobe", result)
  const stream = (JSON.parse(result.stdout) as { streams?: { width?: number; height?: number }[] }).streams?.[0]
  if (!stream?.width || !stream.height) throw new Error("ffprobe reported no size for the storyboard sprite")
  return { width: stream.width, height: stream.height }
}
