import type { JSONContent } from "./prosemirror"

export const VOICE_PROTOCOL_VERSION = 3 as const

export type VoiceTerminationMode = "format" | "send_as_is" | "abort"
export type VoiceRelayPhase = "live" | "formatting" | "closing" | "closed"

export interface VoiceStartAck {
  ok: boolean
  error?: string
  protocolVersion: number
}

export interface VoiceStopPayload {
  mode: VoiceTerminationMode
}

export interface VoiceStopAck {
  ok: boolean
}

export interface VoiceTranscriptDelta {
  voiceSessionId: string
  revision: number
  text: string
  isFinal: boolean
  chunkId?: string
  contentJson?: JSONContent
}

export interface VoiceTranscriptPolished {
  voiceSessionId: string
  chunkId: string
  revision: number
  authoritative: boolean
  raw: string
  polished: string
  rawContentJson?: JSONContent
  polishedContentJson?: JSONContent
}

export interface VoiceStoppedPayload {
  reason: "stopped" | "max_duration"
  revision: number
  outcome: "success" | "empty_input" | "invalid_output" | "timeout" | "canceled" | "provider_error"
}
