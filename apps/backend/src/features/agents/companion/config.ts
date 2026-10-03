import type { TonePreset, BrevityPreset } from "@threahq/types"
import { BUILT_IN_AGENTS, ARIADNE_AGENT_ID } from "../built-in-agents"
import type { Persona } from "../persona-repository"

export const COMPANION_MODEL_ID = BUILT_IN_AGENTS[ARIADNE_AGENT_ID].model

const ariadneTemperature = BUILT_IN_AGENTS[ARIADNE_AGENT_ID].temperature
if (ariadneTemperature == null) {
  throw new Error("Built-in Ariadne configuration is missing temperature (expected a number).")
}
export const COMPANION_TEMPERATURE = ariadneTemperature

export const COMPANION_SUMMARY_MODEL_ID = "openrouter:openai/gpt-6-luna"

// Lower temperature for deterministic summary updates
export const COMPANION_SUMMARY_TEMPERATURE = 0.1

// Episode summaries (roadmap 3.1): a cheap post-completion condensation of what
// the persona did and concluded in a session, stored on the session row and
// replayed into later turns as "Previous sessions". Same small model the memo
// classifier/memorizer runs (`MEMO_CLASSIFIER_MODEL_ID`).
export const EPISODE_SUMMARY_MODEL_ID = "openrouter:openai/gpt-6-luna"
export const EPISODE_SUMMARY_TEMPERATURE = 0.1
export const EPISODE_SUMMARY_MAX_TOKENS = 256

// How many prior completed-session summaries a turn carries in its context.
export const EPISODE_SUMMARY_INJECT_COUNT = 3

// Persona style-slot fragments (roadmap 7.1). Each preset maps to an authored,
// style-only prompt fragment that replaces its aspect's default guidance in the
// `## Response Style` section (buildResponseStyleSection). Backend-only — the
// frontend renders the preset key + a one-line description, never this text —
// and co-located with the persona-style eval suite that asserts each fragment
// shifts output (INV-44, one source). Deliberately capability-free: they steer
// how the persona *sounds* and how *long* it goes, nothing about what it can do.
// A fork materializes the source persona's preset into a custom's free-text slot
// by copying the matching fragment.
export const TONE_PRESET_FRAGMENTS: Record<TonePreset, string> = {
  warm: "Be warm and encouraging. Acknowledge the person's effort or situation, and let genuine care come through in how you phrase things. Keep it natural — warmth lives in the wording, not in added flattery.",
  neutral:
    "Keep an even, professional tone. State things plainly, without emotional coloring, cheerleading, or hedging. Be courteous, and let the substance carry the message.",
  direct:
    "Be blunt and plainspoken. Lead with your actual read of the situation, stated flatly — no empathetic opener, no reassurance, no validating the person's feelings. Skip softening qualifiers and hedges, say the inconvenient thing plainly, and go straight to what you'd do about it.",
}

export const BREVITY_PRESET_FRAGMENTS: Record<BrevityPreset, string> = {
  brief:
    "Be terse. Give the single most useful answer in a sentence or two and stop — cut every word that isn't load-bearing, and skip preamble, restatement, and closing pleasantries. Do not use headings, bullet lists, or multi-part structure; a couple of plain sentences is the whole reply. If the question truly needs more, add one short sentence, not a section.",
  balanced:
    "Match the length to the question. Give a simple question a couple of sentences, and reserve fuller explanations for topics that genuinely need them. Don't pad, but don't strip out context that helps.",
  thorough:
    "Be comprehensive. Walk through the reasoning, cover the relevant edge cases, and lay out steps or alternatives in full when they matter. Prefer completeness over brevity, while still avoiding filler.",
}

/**
 * Resolve a persona's tone/brevity style slots to the text that overrides each
 * aspect's default `## Response Style` guidance. Built-in personas resolve their
 * preset keys to the authored fragments above; custom personas pass their
 * free-text slot content straight through (a fork already materialized any
 * source preset into that text). An unset slot resolves to `undefined`, which
 * `buildResponseStyleSection` reads as "keep the default guidance for this
 * aspect". Free text wins over a preset if both are somehow present (customs
 * never carry presets, so this only guards malformed input).
 */
export function resolvePersonaStyleSlots(persona: Persona): { tone?: string; brevity?: string } {
  const tone = persona.tonePrompt ?? (persona.tonePreset ? TONE_PRESET_FRAGMENTS[persona.tonePreset] : undefined)
  const brevity =
    persona.brevityPrompt ?? (persona.brevityPreset ? BREVITY_PRESET_FRAGMENTS[persona.brevityPreset] : undefined)
  return { tone, brevity }
}

// Prepared recall: before the first model call, the trigger message is matched
// against the memos this turn's audience may read and the decision model keeps
// the ones a reply should take into account. The ladder judges the bearing on
// a reply, not the match to a query: a peanut allergy does not answer "what
// should I bring to the picnic", but a reply that ignored it would be wrong.
// Deliberately free of cues about the content itself (INV-54).
export const PREPARED_RECALL_QUESTION = {
  instructions: (index: number) =>
    `How much should a reply to the message in "query" take candidate [${index}] in the candidates list into account?`,
  criteria: [
    "has no bearing on a reply to the message",
    "shares a topic with the message, but a good reply would not use it",
    "a good reply would take it into account",
    "a reply that ignored it would be wrong, unsafe, or contradict what the people involved have said",
  ],
} as const

/** Between the second and third rungs: a memo is kept only when a good reply would use it. */
export const PREPARED_RECALL_MIN_SCORE = 0.5
export const PREPARED_RECALL_CANDIDATE_LIMIT = 30
export const PREPARED_RECALL_MAX_MEMOS = 5
/** Long pastes carry their point early; the rest only dilutes the embedding. */
export const PREPARED_RECALL_QUERY_MAX_CHARS = 2000
/** The query embedding has no deadline of its own; scoring stops itself at 3 s. */
export const PREPARED_RECALL_TIMEOUT_MS = 5000
