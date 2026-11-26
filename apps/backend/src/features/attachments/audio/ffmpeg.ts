import {
  AUDIO_AAC_BITRATE_PER_CHANNEL,
  AUDIO_INPUT_FORMATS,
  AUDIO_MAX_CHANNELS,
  AUDIO_PCM_SAMPLE_RATE,
  AUDIO_PROBE_TIMEOUT_MS,
  type AudioProbe,
} from "./config"

const INPUT_PROTOCOLS = "http,https,tcp,tls"
const STDERR_TAIL_BYTES = 4096

export interface AudioTools {
  ffmpegPath: string
  ffprobePath: string
}

/** The input is readable but is not audio ffmpeg can decode; retrying cannot help. */
export class UndecodableAudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UndecodableAudioError"
  }
}

export function resolveAudioTools(): AudioTools | null {
  const ffmpegPath = Bun.which("ffmpeg")
  const ffprobePath = Bun.which("ffprobe")
  if (!ffmpegPath || !ffprobePath) return null
  return { ffmpegPath, ffprobePath }
}

/** ffmpeg's fixed messages for input that matches no known format, or one outside the allowed list. */
const UNDECODABLE_STDERR = /Invalid data found when processing input|Format not on whitelist/

interface RunResult {
  exitCode: number
  stdout: string
  stderrTail: string
}

async function readTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  let tail = Buffer.alloc(0)
  for await (const chunk of stream) {
    tail = Buffer.concat([tail, chunk])
    if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES)
  }
  return tail.toString("utf8").trim()
}

/** The presigned input URL carries a live signature, so it never reaches error messages. */
async function run(
  cmd: string[],
  inputUrl: string,
  timeoutMs: number,
  onStdout?: (chunk: Uint8Array) => void
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, timeoutMs)
  try {
    const stderrTail = readTail(proc.stderr)
    let stdout = ""
    if (onStdout) {
      for await (const chunk of proc.stdout) onStdout(chunk)
    } else {
      stdout = await new Response(proc.stdout).text()
    }
    const exitCode = await proc.exited
    const tail = (await stderrTail).replaceAll(inputUrl, "<input>")
    if (timedOut) throw new Error(`${cmd[0]} timed out after ${timeoutMs} ms: ${tail}`)
    return { exitCode, stdout, stderrTail: tail }
  } catch (error) {
    proc.kill("SIGKILL")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function failure(tool: string, result: RunResult): Error {
  const message = `${tool} exited with ${result.exitCode}: ${result.stderrTail}`
  return UNDECODABLE_STDERR.test(result.stderrTail) ? new UndecodableAudioError(message) : new Error(message)
}

/** Returns null when the input has no audio stream. */
export async function probeAudio(tools: AudioTools, inputUrl: string): Promise<AudioProbe | null> {
  const result = await run(
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
  if (result.exitCode !== 0) throw failure("ffprobe", result)

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
export async function runNormalize(tools: AudioTools, params: NormalizeParams): Promise<void> {
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
  const result = await run(
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
  if (result.exitCode !== 0) throw failure("ffmpeg", result)
}
