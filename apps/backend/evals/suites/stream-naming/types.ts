/**
 * Stream Naming Evaluation Types
 */

/**
 * Input for stream naming evaluation.
 */
export interface StreamNamingInput {
  /** Formatted conversation text */
  conversationText: string
  /** Existing stream names to avoid */
  existingNames?: string[]
  /** Compatibility shorthand: true maps to forced checkpoint 3; false to checkpoint 1. */
  requireName?: boolean
  currentTitle?: string | null
  checkpoint?: 1 | 3 | 6 | 10
  forced?: boolean
  /** Category for organizing test cases */
  category?: "technical" | "casual" | "question" | "minimal" | "duplicate-avoidance" | "language"
}

/**
 * Output from stream naming.
 */
export interface StreamNamingOutput {
  /** The input that was provided */
  input: StreamNamingInput
  action: "defer" | "keep" | "rename"
  /** Generated name, or the current title for keep. */
  name: string | null
  /** Whether NOT_ENOUGH_CONTEXT was returned */
  notEnoughContext: boolean
  /** Error message if generation failed */
  error?: string
}

/**
 * Expected output for evaluation.
 */
export interface StreamNamingExpected {
  expectedAction?: "defer" | "keep" | "rename"
  /** Should return defer. */
  expectNotEnoughContext?: boolean
  /** Name should contain these words/phrases (case-insensitive) */
  nameContains?: string[]
  /** Name should NOT contain these words/phrases */
  nameNotContains?: string[]
  /** Expected word count range */
  wordCountRange?: { min: number; max: number }
  /** Should avoid existing names */
  shouldAvoidExisting?: boolean
  /** Allow generic names for edge cases (e.g., minimal context with requireName) */
  allowGeneric?: boolean
}
