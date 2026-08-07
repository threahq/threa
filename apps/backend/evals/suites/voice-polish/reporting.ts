import type { PermutationResult, SuiteResult } from "../../framework/types"
import { voicePolishConfig } from "../../../src/features/voice-transcription/config"
import type { VoicePolishExpected, VoicePolishOutput } from "./types"
import {
  previousAcceptedVariantShips,
  qualifyVoicePolishPermutation,
  selectVoicePolishModel,
  type Qualification,
} from "./evaluators"

export interface VoicePolishComparisonDecision {
  qualifications: Array<{ model: string; promptVariant: string | null; qualification: Qualification }>
  selectedModel: string | null
  previousAcceptedShips: boolean | null
  exitAllowed: boolean
  reasons: string[]
}

export function decideVoicePolishComparison(
  results: Array<SuiteResult<unknown, unknown>>
): VoicePolishComparisonDecision | null {
  const permutations = results
    .filter((result) => result.suiteName === "voice-polish" || result.suiteName.startsWith("voice-polish:"))
    .flatMap((result) => result.permutations) as Array<PermutationResult<VoicePolishOutput, VoicePolishExpected>>
  if (permutations.length === 0) return null

  const qualifications = permutations.map((permutation) => ({
    model: permutation.permutation.model,
    promptVariant: permutation.permutation.promptVariant ?? null,
    qualification: qualifyVoicePolishPermutation(permutation),
  }))
  const enabled = qualifications.filter((item) => item.promptVariant !== "without-previous")
  const reasons: string[] = []
  let selectedModel: string | null = null
  try {
    selectedModel = selectVoicePolishModel(
      voicePolishConfig.model,
      enabled.map(({ model, qualification }) => ({ model, qualification }))
    )
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error))
  }
  if (!selectedModel) reasons.push("No model satisfies the production qualification and challenger-selection rules")

  const productionEnabled = qualifications.find(
    (item) => item.model === voicePolishConfig.model && item.promptVariant !== "without-previous"
  )
  const withoutPrevious = qualifications.find(
    (item) => item.model === voicePolishConfig.model && item.promptVariant === "without-previous"
  )
  let previousAcceptedShips: boolean | null = null
  if (withoutPrevious) {
    if (!productionEnabled) reasons.push(`Missing previous-accepted production result for ${voicePolishConfig.model}`)
    // The enabled (production) variant must qualify; the without-previous baseline
    // need not — its failures are the evidence that the previous-accepted prompt
    // earns its place. The comparison itself is per-case-rate based.
    else if (!productionEnabled.qualification.qualified) {
      reasons.push("Previous-accepted production permutation does not qualify")
    } else {
      const sample = permutations.find(
        (item) =>
          item.permutation.model === voicePolishConfig.model && item.permutation.promptVariant !== "without-previous"
      )
      const stabilityIds = [
        ...new Set(sample?.cases.filter((item) => item.expectedOutput.stability).map((item) => item.caseId) ?? []),
      ]
      const correctionIds = [
        ...new Set(
          sample?.cases.filter((item) => item.expectedOutput.correctionOrStructure).map((item) => item.caseId) ?? []
        ),
      ]
      previousAcceptedShips = previousAcceptedVariantShips(
        productionEnabled.qualification,
        withoutPrevious.qualification,
        stabilityIds,
        correctionIds
      )
      if (!previousAcceptedShips)
        reasons.push("Previous-accepted prompt did not improve stability without correction regression")
    }
  }

  return {
    qualifications,
    selectedModel,
    previousAcceptedShips,
    exitAllowed: reasons.length === 0 && selectedModel !== null,
    reasons,
  }
}
