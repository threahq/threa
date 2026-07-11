/**
 * Memorizer Evaluation Types
 */

import type { EvalClassifierMessage, EvalExistingMemo } from "../memo-classifier/types"

export interface MemorizerInput {
  messages: EvalClassifierMessage[]
  /** Prior stream memo abstracts (vocabulary context). */
  memoryContext?: string[]
  /** Existing memos for this conversation — presence selects the revision path. */
  existingMemos?: EvalExistingMemo[]
  category?: "extraction" | "revision" | "selectivity" | "transient"
}

export interface MemorizerOutputMemo {
  title: string
  abstract: string
  knowledgeType: string
  keyPoints: string[]
  tags: string[]
  /** Existing-memo ids this memo explicitly retires (reversed/replaced conclusion). */
  supersedesMemoIds: string[]
}

export interface MemorizerOutput {
  input: MemorizerInput
  memos: MemorizerOutputMemo[]
  error?: string
}

export interface MemorizerExpected {
  /** Exact upper bound on returned memos. */
  maxMemos?: number
  /** At least this many memos. */
  minMemos?: number
  /**
   * Each inner list is an OR-group: some memo's title+abstract must contain at
   * least one of its words. All groups must be satisfied.
   */
  mustCoverAny?: string[][]
  /** No memo's title or abstract may contain any of these words. */
  mustNotContain?: string[]
  /**
   * LLM-judged semantic direction check: some memo must assert this conclusion.
   * Catches inversions that keyword checks can't (a memo can mention both sides
   * of a decision; what matters is which side it says WON).
   */
  conclusionMustState?: string
  /** LLM-judged: no memo may assert this conclusion (the abandoned/reversed side). */
  conclusionMustNotState?: string
  /** Some memo must explicitly retire at least one existing memo via supersedesMemoIds. */
  expectSupersedesExisting?: boolean
}
