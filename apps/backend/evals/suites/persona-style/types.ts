/**
 * Persona-Style Evaluation Types
 */

import type { TonePreset, BrevityPreset } from "@threa/types"

export interface PersonaStyleInput {
  /** Which style slot the case exercises (`control` sets neither slot). */
  dimension: "tone" | "brevity" | "control"
  /**
   * Tone preset whose authored fragment is seeded into the persona's tone slot.
   * Absent → the tone aspect keeps its default `## Response Style` guidance.
   */
  tonePreset?: TonePreset
  /**
   * Brevity preset whose authored fragment is seeded into the brevity slot.
   * Absent → the brevity aspect keeps its default guidance.
   */
  brevityPreset?: BrevityPreset
  /** The user message that fires the companion turn. */
  message: string
}

export interface PersonaStyleOutput {
  input: PersonaStyleInput
  /** The agent's reply (all messages it posted, concatenated). */
  reply: string
  /** Whether the agent posted a non-empty reply. */
  responded: boolean
  /** Whitespace-delimited word count of `reply`. */
  wordCount: number
  /** Character count of `reply`. */
  charCount: number
  error?: string
}

export interface PersonaStyleExpected {
  /** The reply must be non-empty — style can only be graded on actual output. */
  shouldRespond: boolean
  /** LLM-judged: the reply must exhibit this tone (tone cases only). */
  tone?: TonePreset
  /**
   * Deterministic word-count band the reply must fall in (brevity cases). Omit
   * for cases whose brevity signal is the cross-case ordering, not an absolute
   * count.
   */
  brevityBand?: { maxWords?: number; minWords?: number }
}
