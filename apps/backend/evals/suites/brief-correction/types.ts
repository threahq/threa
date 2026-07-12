/**
 * Brief Correction Evaluation Types
 */

export interface BriefCorrectionInput {
  /** Which arm of the correction loop the case exercises. */
  category: "states-decision" | "contradicts-brief" | "chitchat"
  /** Prior scratchpad turns seeded before the trigger message. */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
  /**
   * Brief content seeded (as a member edit) before the turn runs. Present on the
   * `contradicts-brief` cases so the turn has a standing fact to correct.
   */
  existingBrief?: string
  /** The user message that fires the companion turn. */
  message: string
}

export interface BriefCorrectionOutput {
  input: BriefCorrectionInput
  /** The turn added a brief revision (created or updated the brief). */
  wrote: boolean
  /** Brief content after the turn (null when no brief exists). */
  briefContent: string | null
  /** Brief version after the turn (0 when no brief exists). */
  briefVersion: number
  /** `stream_brief_revisions` rows after the turn. */
  revisionCount: number
  /** `stream_brief_revisions` rows before the turn (1 when a brief was seeded, else 0). */
  revisionsBefore: number
  error?: string
}

export interface BriefCorrectionExpected {
  /** Whether the turn should write the brief. `false` is the over-eager-write guard. */
  shouldWrite: boolean
  /**
   * LLM-judged: the resulting brief must assert this fact/decision. Checked only
   * on write-expected cases.
   */
  briefMustState?: string
  /**
   * LLM-judged: the resulting brief must NOT still assert this — the value the
   * user contradicted. Catches append-instead-of-replace (the brief is a full
   * replacement, not an accretion log).
   */
  briefMustNotState?: string
}
