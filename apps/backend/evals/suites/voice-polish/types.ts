import type { JSONContent, VoicePolishLevel } from "@threa/types"
import type { PolishOutcome } from "../../../src/features/voice-transcription/polish"

export interface VoicePolishStep {
  rawTranscript: string
  deadline?: "live" | "final"
  draftBefore?: string
  draftAfter?: string
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
}

export interface VoicePolishStepOutput {
  outcome: PolishOutcome
  durationMs: number
  deadline: "live" | "final"
  previousAcceptedMarkdown?: string
  forbiddenContextTerms: string[]
}

export interface VoicePolishOutput {
  steps: VoicePolishStepOutput[]
  outcome: PolishOutcome
  markdown?: string
  contentJson?: JSONContent
  durationMs: number
}
