import { logger } from "../../../lib/logger"
import { voiceConfig } from "../config"
import type {
  TranscriptionStrategy,
  TranscriptionSession,
  TranscriptionOpenOptions,
  TranscriptionDelta,
  TranscriptionError,
  TranscriptionResult,
} from "./strategy"

export interface DeepgramStrategyConfig {
  apiKey: string
}

const REALTIME_URL = "wss://api.deepgram.com/v1/listen"
const SAMPLE_RATE_HZ = voiceConfig.sampleRateHz
/** PCM16 mono: 2 bytes/sample, so ms = bytes / (2 * 16000 / 1000) = bytes / 32. */
const BYTES_PER_MS = (SAMPLE_RATE_HZ * 2) / 1000

/**
 * Map our registry model id (`deepgram:nova-3`) to Deepgram's `model` query
 * param (`nova-3`). Only the suffix is provider-facing.
 */
function toUpstreamModelId(model: string): string {
  const colon = model.indexOf(":")
  return colon === -1 ? model : model.slice(colon + 1)
}

/**
 * Deepgram Nova-3 realtime strategy — opens an STT WebSocket, streams binary
 * PCM16 (16kHz mono) frames up, and surfaces transcript deltas.
 *
 * Wire protocol: connect with `Authorization: Token <key>` and `encoding`,
 * `sample_rate`, `channels`, `model`, `interim_results`, `endpointing` as
 * query params. Audio frames are sent as raw binary (not JSON). Transcript
 * messages come back as JSON with `type: "Results"`, with `is_final` marking
 * the commit point for a segment.
 */
export class RealtimeDeepgramStrategy implements TranscriptionStrategy {
  readonly provider = "deepgram"
  private readonly apiKey: string

  constructor(config: DeepgramStrategyConfig) {
    this.apiKey = config.apiKey
  }

  async open(opts: TranscriptionOpenOptions): Promise<TranscriptionSession> {
    const session = new DeepgramSession(this.apiKey, opts)
    await session.connect()
    return session
  }
}

/**
 * Upper bound on how long {@link DeepgramSession.flush} will wait for the
 * post-CloseStream final transcript before giving up. Deepgram is normally
 * sub-second; the cap is just a safety net so the gateway doesn't hang on a
 * dead upstream.
 */
const FLUSH_FINAL_WAIT_MS = 1500

class DeepgramSession implements TranscriptionSession {
  private readonly deltaCallbacks: Array<(delta: TranscriptionDelta) => void> = []
  private readonly errorCallbacks: Array<(e: TranscriptionError) => void> = []
  private ws: WebSocket | null = null
  private totalAudioMs = 0
  private chunksSent = 0
  private openedAt = 0
  private closed = false
  /** Resolves when the post-flush final transcript lands (or the timeout fires). */
  private pendingFlush: (() => void) | null = null

  constructor(
    private readonly apiKey: string,
    private readonly opts: TranscriptionOpenOptions
  ) {}

  connect(): Promise<void> {
    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE_HZ),
      channels: "1",
      model: toUpstreamModelId(this.opts.model),
      interim_results: "true",
      // Endpointing (ms of silence to mark utterance end) is what makes Deepgram
      // emit speech_final/is_final segments without us sending CloseStream — the
      // same role VAD plays for ElevenLabs.
      endpointing: "300",
    })
    if (this.opts.language) params.set("language", this.opts.language)
    const url = `${REALTIME_URL}?${params.toString()}`

    // Bun's WebSocket accepts a non-standard options arg for request headers.
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } } as never)
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      let settled = false

      ws.addEventListener("open", () => {
        if (settled) return
        settled = true
        this.openedAt = Date.now()
        resolve()
      })

      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true
          reject(new Error("Deepgram realtime connection failed"))
          return
        }
        this.emitError({ code: "UPSTREAM_ERROR", message: "Deepgram realtime socket error" })
      })

      ws.addEventListener("close", (event) => {
        if (!settled) {
          settled = true
          reject(new Error(`Deepgram realtime closed before open (code ${event.code})`))
          return
        }
        logger.info(
          {
            provider: "deepgram",
            code: event.code,
            reason: event.reason || null,
            wasClean: event.wasClean,
            initiatedByUs: this.closed,
            chunksSent: this.chunksSent,
            totalAudioMs: Math.round(this.totalAudioMs),
            connectedMs: this.openedAt ? Date.now() - this.openedAt : null,
          },
          "Deepgram realtime socket closed"
        )
        if (!this.closed) {
          this.emitError({ code: "UPSTREAM_CLOSED", message: `Deepgram realtime closed (code ${event.code})` })
        }
      })

      ws.addEventListener("message", (event) => this.handleMessage(event.data))
    })
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return
    let data: {
      type?: string
      is_final?: boolean
      channel?: { alternatives?: Array<{ transcript?: string }> }
      error?: string
      message?: string
    }
    try {
      data = JSON.parse(raw)
    } catch {
      logger.warn({ provider: "deepgram" }, "Failed to parse realtime transcript message")
      return
    }

    switch (data.type) {
      case "Results": {
        const text = data.channel?.alternatives?.[0]?.transcript ?? ""
        const isFinal = data.is_final === true
        if (isFinal) this.resolvePendingFlush()
        if (!text) return
        this.emitDelta({ text, isFinal })
        return
      }
      case "Metadata":
      case "SpeechStarted":
      case "UtteranceEnd":
        return
      case "Error":
        this.emitError({ code: "INPUT_ERROR", message: data.error ?? data.message ?? "Upstream input error" })
        return
      default:
        return
    }
  }

  pushAudio(frame: Buffer): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.totalAudioMs += frame.length / BYTES_PER_MS
    this.chunksSent++
    // Deepgram takes raw PCM bytes, not a JSON envelope.
    this.ws.send(frame)
  }

  async flush(): Promise<void> {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Deepgram's CloseStream is request-response: it asks the server to commit
    // any buffered audio and reply with one last `is_final=true` Results frame.
    // The gateway immediately calls close() after flush(), so if we returned
    // here right away the socket teardown would race the final frame and the
    // user's last utterance would silently disappear. Wait for the final
    // Results (resolved from handleMessage) or the safety timeout.
    this.ws.send(JSON.stringify({ type: "CloseStream" }))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFlush = null
        resolve()
      }, FLUSH_FINAL_WAIT_MS)
      this.pendingFlush = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private resolvePendingFlush(): void {
    if (!this.pendingFlush) return
    const cb = this.pendingFlush
    this.pendingFlush = null
    // The server initiates a clean socket close right after the final Results
    // frame. Mark closed so the upcoming close event isn't surfaced as a
    // spurious UPSTREAM_CLOSED to the user.
    this.closed = true
    cb()
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
