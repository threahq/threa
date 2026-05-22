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
  /** Whether a name is required (true for agent messages) */
  requireName?: boolean
  /** Category for organizing test cases */
  category?: "technical" | "casual" | "question" | "minimal" | "duplicate-avoidance" | "language"
}

/**
 * Output from stream naming.
 */
export interface StreamNamingOutput {
  /** The input that was provided */
  input: StreamNamingInput
  /** Generated name or null if NOT_ENOUGH_CONTEXT */
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
  /** Should return NOT_ENOUGH_CONTEXT */
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
