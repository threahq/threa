import type { AI, DecisionsAvailability } from "@threahq/agent-runtime"
import type { ConfigResolver } from "../../../lib/ai/config-resolver"
import type { AIResidencyPolicy } from "../../ai-usage"
import { DecisionsBoundaryExtractor } from "./decisions-extractor"
import { LLMBoundaryExtractor } from "./llm-extractor"
import { ResidencyRoutedBoundaryExtractor } from "./residency-routed-extractor"
import type { BoundaryExtractor } from "./types"

export function createBoundaryExtractor(deps: {
  ai: AI
  configResolver: ConfigResolver
  aiResidency: AIResidencyPolicy
  decisionsAvailability: DecisionsAvailability
}): BoundaryExtractor {
  return new ResidencyRoutedBoundaryExtractor({
    residency: deps.aiResidency,
    decisions: new DecisionsBoundaryExtractor(deps.ai, deps.configResolver),
    inference: new LLMBoundaryExtractor(deps.ai, deps.configResolver),
    availability: deps.decisionsAvailability,
  })
}
