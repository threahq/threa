import type { ModelRegistry } from "../../../lib/ai/model-registry"
import { logger } from "../../../lib/logger"
import { parseModelProvider } from "../config"
import { RealtimeDeepgramStrategy } from "./realtime-deepgram"
import { RealtimeElevenLabsStrategy } from "./realtime-elevenlabs"

/**
 * A single transcript update from the upstream provider. `isFinal` marks the
 * point at which the preceding interim span is committed and will not be
 * revised. The PR1 skeleton only inserts final text; interim-replacement
 * lands in PR2.
 */
export interface TranscriptionDelta {
  text: string
  isFinal: boolean
}

export interface TranscriptionError {
  code: string
  message: string
}

/** Result of closing a session, used for cost recording (wired in PR3). */
export interface TranscriptionResult {
  totalAudioMs: number
  costUsd?: number
}

/**
 * A live upstream transcription session. One per active dictation; opened by a
 * strategy and driven by the realtime gateway: PCM16 frames in, deltas out.
 */
export interface TranscriptionSession {
  /** Append a PCM16 (16kHz mono) audio frame to the upstream stream. */
  pushAudio(frame: Buffer): void
  /** Ask upstream to commit any buffered audio (e.g. on stop). */
  flush(): Promise<void>
  onDelta(cb: (delta: TranscriptionDelta) => void): void
  onError(cb: (e: TranscriptionError) => void): void
  /** Tear down the upstream socket; resolves with billed audio duration. */
  close(): Promise<TranscriptionResult>
}

export interface TranscriptionOpenOptions {
  /** Full model id, e.g. "elevenlabs:scribe-v2-realtime". */
  model: string
  /** Language hint (BCP-47 or provider code); omit for auto-detect. */
  language?: string
  /** Keyterm/biasing hints (provider-capped). Wired through in PR4. */
  vocabulary?: string[]
}

/**
 * A provider-specific transcription strategy. Each implementation owns one
 * provider's upstream WebSocket protocol; the gateway only sees this interface.
 */
export interface TranscriptionStrategy {
  readonly provider: string
  open(opts: TranscriptionOpenOptions): Promise<TranscriptionSession>
}

export interface TranscriptionFactoryConfig {
  /** Present when ELEVENLABS_API_KEY is configured; absent disables the provider. */
  elevenlabs?: { apiKey: string }
  /** Present when DEEPGRAM_API_KEY is configured; absent disables the provider. */
  deepgram?: { apiKey: string }
  modelRegistry: ModelRegistry
}

/**
 * The transcription factory — the createAI-adjacent entry point for the STT
 * modality (INV-28). It resolves the right provider strategy from the model id
 * and validates the model is an audio/realtime model before opening a session.
 * Cost recording on close() is layered on in PR3.
 */
export interface Transcription {
  open(opts: TranscriptionOpenOptions): Promise<TranscriptionSession>
}

export function createTranscription(config: TranscriptionFactoryConfig): Transcription {
  const { modelRegistry } = config

  const strategies = new Map<string, TranscriptionStrategy>()
  if (config.elevenlabs) {
    strategies.set("elevenlabs", new RealtimeElevenLabsStrategy({ apiKey: config.elevenlabs.apiKey }))
  }
  if (config.deepgram) {
    strategies.set("deepgram", new RealtimeDeepgramStrategy({ apiKey: config.deepgram.apiKey }))
  }

  return {
    async open(opts: TranscriptionOpenOptions): Promise<TranscriptionSession> {
      if (!modelRegistry.supportsAudioInput(opts.model)) {
        throw new Error(`Model does not support audio input: ${opts.model}`)
      }
      const provider = parseModelProvider(opts.model)
      if (!provider) {
        throw new Error(`Voice model must include a provider prefix: ${opts.model}`)
      }
      const strategy = strategies.get(provider)
      if (!strategy) {
        throw new Error(`No transcription strategy available for provider: ${provider}`)
      }
      logger.debug({ model: opts.model, provider }, "Opening upstream transcription session")
      return strategy.open(opts)
    },
  }
}
