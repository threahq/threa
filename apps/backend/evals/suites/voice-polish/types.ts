import type { JSONContent, VoicePolishLevel } from "@threa/types"
import type { PolishOutcome, VoicePolishAttempt } from "../../../src/features/voice-transcription/polish"
import type { IncrementalPolishResult } from "../../../src/features/voice-transcription/incremental-coordinator"

export interface VoicePolishStep {
  rawTranscript: string
  deadline?: "live" | "final"
  draftBefore?: string
  draftAfter?: string
  ackStatus?: "applied" | "stale" | "locked" | "missing" | "non_contiguous" | "invalid" | "timeout"
  stopWithoutNewFinal?: boolean
}

export interface VoicePolishInput {
  steps: VoicePolishStep[]
  level?: VoicePolishLevel
  draftBefore?: string
  draftAfter?: string
  steeringTerms?: string[]
}

export interface VoicePolishExpected {
  requiredTerms?: string[]
  forbiddenTerms?: string[]
  forbiddenContextTerms?: string[]
  blockTypes?: string[]
  listItemCounts?: number[]
  languageMarkers?: string[]
  forbiddenTranslations?: string[]
  stability?: "prior-content"
  correctionOrStructure?: boolean
  expectedScope?: "tail" | "widen_previous" | "preserve_raw"
  predecessorStable?: boolean
  expectedFinalResult?: "reused" | "rejected"
  expectedAckStatus?: VoicePolishStep["ackStatus"]
  expectedFinalModelCalls?: number
}

export interface VoicePolishStepOutput {
  outcome: PolishOutcome
  coordinatorResult?: IncrementalPolishResult
  composedDocument?: PolishOutcome
  attempts?: VoicePolishAttempt[]
  scope?: "tail" | "widen_previous" | "preserve_raw"
  durationMs: number
  deadline: "live" | "final"
  previousAcceptedMarkdown?: string
  stage?: "scope" | "normal_live" | "normal_final" | "widen"
  sourceWindowCount?: number
  rawCharCount?: number
  reasoningEffort?: string
  finalCallMade?: boolean
  finalModelCallCount?: number
  reused?: boolean
  predecessorStable?: boolean
  forbiddenContextTerms: string[]
}

export interface VoicePolishOutput {
  steps: VoicePolishStepOutput[]
  outcome: PolishOutcome
  composedDocument?: PolishOutcome
  markdown?: string
  contentJson?: JSONContent
  durationMs: number
}
