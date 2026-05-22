import { logger } from "../../../lib/logger"
import type {
  TranscriptionStrategy,
  TranscriptionSession,
  TranscriptionOpenOptions,
  TranscriptionDelta,
  TranscriptionError,
  TranscriptionResult,
} from "./strategy"

export interface ElevenLabsStrategyConfig {
  apiKey: string
}

const REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
const SAMPLE_RATE_HZ = 16_000
/** PCM16 mono: 2 bytes/sample, so ms = bytes / (2 * 16000 / 1000) = bytes / 32. */
const BYTES_PER_MS = (SAMPLE_RATE_HZ * 2) / 1000

/**
 * Map our registry model id (`elevenlabs:scribe-v2-realtime`) to the ElevenLabs
 * `model_id` query param (`scribe_v2_realtime`). Only the suffix is provider-facing.
 */
function toUpstreamModelId(model: string): string {
  const colon = model.indexOf(":")
  const suffix = colon === -1 ? model : model.slice(colon + 1)
  return suffix.replace(/-/g, "_")
}

/**
 * ElevenLabs Scribe v2 Realtime strategy — opens a realtime STT WebSocket,
 * streams PCM16 (16kHz mono) frames up, and surfaces transcript deltas.
 *
 * Wire protocol (server-side streaming): connect with the `xi-api-key` header,
 * send audio as `{ message_type: "input_audio_chunk", audio_base_64, commit,
 * sample_rate }`, and read transcripts off incoming `message_type`s
 * (`partial_transcript` interim / `committed_transcript` final).
 */
export class RealtimeElevenLabsStrategy implements TranscriptionStrategy {
  readonly provider = "elevenlabs"
  private readonly apiKey: string

  constructor(config: ElevenLabsStrategyConfig) {
    this.apiKey = config.apiKey
  }

  async open(opts: TranscriptionOpenOptions): Promise<TranscriptionSession> {
    const session = new ElevenLabsSession(this.apiKey, opts)
    await session.connect()
    return session
  }
}

class ElevenLabsSession implements TranscriptionSession {
  private readonly deltaCallbacks: Array<(delta: TranscriptionDelta) => void> = []
  private readonly errorCallbacks: Array<(e: TranscriptionError) => void> = []
  private ws: WebSocket | null = null
  private totalAudioMs = 0
  private closed = false

  constructor(
    private readonly apiKey: string,
    private readonly opts: TranscriptionOpenOptions
  ) {}

  connect(): Promise<void> {
    const params = new URLSearchParams({ model_id: toUpstreamModelId(this.opts.model) })
    if (this.opts.language) params.set("language_code", this.opts.language)
    const url = `${REALTIME_URL}?${params.toString()}`

    // Bun's WebSocket accepts a non-standard options arg for request headers.
    const ws = new WebSocket(url, { headers: { "xi-api-key": this.apiKey } } as never)
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      let settled = false

      ws.addEventListener("open", () => {
        if (settled) return
        settled = true
        resolve()
      })

      ws.addEventListener("error", () => {
        // The DOM ErrorEvent carries no useful detail; surface a generic message.
        if (!settled) {
          settled = true
          reject(new Error("ElevenLabs realtime connection failed"))
          return
        }
        this.emitError({ code: "UPSTREAM_ERROR", message: "ElevenLabs realtime socket error" })
      })

      ws.addEventListener("close", (event) => {
        if (!settled) {
          settled = true
          reject(new Error(`ElevenLabs realtime closed before open (code ${event.code})`))
        }
      })

      ws.addEventListener("message", (event) => this.handleMessage(event.data))
    })
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return
    let data: { message_type?: string; text?: string; error?: string; message?: string }
    try {
      data = JSON.parse(raw)
    } catch {
      logger.warn({ provider: "elevenlabs" }, "Failed to parse realtime transcript message")
      return
    }

    switch (data.message_type) {
      case "session_started":
        return
      case "partial_transcript":
        if (data.text) this.emitDelta({ text: data.text, isFinal: false })
        return
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        if (data.text) this.emitDelta({ text: data.text, isFinal: true })
        return
      case "input_error":
        this.emitError({ code: "INPUT_ERROR", message: data.error ?? data.message ?? "Upstream input error" })
        return
      default:
        return
    }
  }

  pushAudio(frame: Buffer): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.totalAudioMs += frame.length / BYTES_PER_MS
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: frame.toString("base64"),
        commit: false,
        sample_rate: SAMPLE_RATE_HZ,
      })
    )
  }

  async flush(): Promise<void> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: SAMPLE_RATE_HZ,
      })
    )
  }

  onDelta(cb: (delta: TranscriptionDelta) => void): void {
    this.deltaCallbacks.push(cb)
  }

  onError(cb: (e: TranscriptionError) => void): void {
    this.errorCallbacks.push(cb)
  }

  private emitDelta(delta: TranscriptionDelta): void {
    for (const cb of this.deltaCallbacks) cb(delta)
  }

  private emitError(e: TranscriptionError): void {
    for (const cb of this.errorCallbacks) cb(e)
  }

  async close(): Promise<TranscriptionResult> {
    this.closed = true
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.close()
    }
    this.ws = null
    return { totalAudioMs: Math.round(this.totalAudioMs) }
  }
}
