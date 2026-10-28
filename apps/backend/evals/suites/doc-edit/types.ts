/**
 * Doc Edit Evaluation Types
 */

export interface DocEditInput {
  /** Prior scratchpad turns seeded before the trigger message. */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>
  /** The user message that fires the companion turn. */
  message: string
}

/** A section whose markdown moved during the turn; `before === null` means the section was added. */
export interface DocSectionChange {
  blockId: string
  before: string | null
  after: string
}

export interface DocEditOutput {
  input: DocEditInput
  /** The turn applied at least one agent write of any kind. */
  wrote: boolean
  /** `personaUpdateCount + createdDocCount + (titleChanged ? 1 : 0)`. */
  writeCount: number
  /** `doc_updates` rows on the seeded doc attributed to the persona. */
  personaUpdateCount: number
  /** Doc streams created under the scratchpad during the turn. */
  createdDocCount: number
  /** The seeded doc's title no longer matches the seeded one. */
  titleChanged: boolean
  /** Sections changed or added during the turn, keyed by block id. */
  touchedSections: DocSectionChange[]
  /** Block ids in the seeded baseline that are gone after the turn. */
  removedBlockIds: string[]
  /** `reason` of each persona `doc:edited` event on the doc. */
  reasons: string[]
  error?: string
}

export interface DocEditExpected {
  /** Whether the turn should write the doc. `false` is the over-eager-write guard. */
  shouldWrite: boolean
  /** Some touched section must match this after the turn. Checked only on write-expected cases. */
  touchedSectionMustMatch?: RegExp
  /** Upper bound on touched sections. Checked only on write-expected cases. */
  maxTouchedSections?: number
  /** Lines of a changed section's `before` that may disappear; every other line must survive. */
  replaceableLine?: RegExp
}
