import type { JSONContent } from "./prosemirror"

export const VOICE_PROTOCOL_VERSION = 4 as const
export const VOICE_LEGACY_PROTOCOL_VERSION = 3 as const

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

export interface VoiceTranscriptDeltaV3 {
  voiceSessionId: string
  revision: number
  text: string
  isFinal: boolean
  chunkId?: string
  contentJson?: JSONContent
}

interface VoiceTranscriptDeltaV4Base {
  protocolVersion: 4
  voiceSessionId: string
  revision: number
  text: string
}
export type VoiceTranscriptDeltaV4 =
  | (VoiceTranscriptDeltaV4Base & { isFinal: false })
  | (VoiceTranscriptDeltaV4Base & {
      isFinal: true
      chunkId: string
      afterChunkId?: string
      contentJson: JSONContent
    })

export type VoiceTranscriptDelta = VoiceTranscriptDeltaV3 | VoiceTranscriptDeltaV4

export interface VoiceTranscriptPolishedV3 {
  voiceSessionId: string
  chunkId: string
  revision: number
  authoritative: boolean
  raw: string
  polished: string
  rawContentJson?: JSONContent
  polishedContentJson?: JSONContent
}

export const VOICE_REPLACEMENT_ACK_STATUSES = [
  "applied",
  "stale",
  "locked",
  "missing",
  "non_contiguous",
  "invalid",
] as const
export type VoiceReplacementAckStatus = (typeof VOICE_REPLACEMENT_ACK_STATUSES)[number]

export interface VoiceTranscriptReplacementSourceV4 {
  chunkId: string
  throughRevision: number
}

export interface VoiceTranscriptReplacementV4 {
  protocolVersion: 4
  operationId: string
  voiceSessionId: string
  authoritative: boolean
  resultChunkId: string
  throughRevision: number
  sources: VoiceTranscriptReplacementSourceV4[]
  raw: string
  polished: string
  rawContentJson: JSONContent
  polishedContentJson: JSONContent
}

export type VoiceTranscriptPolished = VoiceTranscriptPolishedV3 | VoiceTranscriptReplacementV4

export interface VoiceTranscriptReplacementAck {
  operationId: string
  status: VoiceReplacementAckStatus
}

export const VOICE_STOPPED_OUTCOMES = [
  "success",
  "empty_input",
  "invalid_output",
  "timeout",
  "canceled",
  "provider_error",
  "preserve_raw",
  "replacement_rejected",
] as const
export type VoiceStoppedOutcome = (typeof VOICE_STOPPED_OUTCOMES)[number]

export interface VoiceStoppedPayload {
  reason: "stopped" | "max_duration"
  revision: number
  outcome: VoiceStoppedOutcome
}
