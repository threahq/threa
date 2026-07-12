/**
 * Persona-Style Eval Config
 *
 * Targeted suite proving each authored Tone/Brevity slot fragment shifts the
 * companion's output (roadmap 7.1). It runs the PRODUCTION PersonaAgent.run()
 * with a persona whose style slots carry the fragment text, so it exercises the
 * real `resolvePersonaStyleSlots` → `buildResponseStyleSection` → `buildSystemPrompt`
 * assembly (INV-45). Fragments import from the one source (`companion/config.ts`,
 * INV-44) — never re-authored here.
 *
 * Model is pinned to a cheap chat model rather than Ariadne's production model:
 * the slots steer *style*, which any competent chat model exhibits, and the full
 * companion suite already covers Ariadne on her real model. NEVER pass `-m` to
 * run this — it steamrolls the ConfigResolver-backed sub-agent models and breaks
 * strict structured output; the model lives in `defaultPermutations` (for
 * `-s persona-style`) and in `persona-style.yaml` (for `--config`).
 */

export const PERSONA_STYLE_MODEL_ID = "openrouter:anthropic/claude-haiku-4.5"
export const PERSONA_STYLE_TEMPERATURE = 0.7

/** Judge model for tone adherence — the shared cheap judge the other suites use. */
export const PERSONA_STYLE_JUDGE_MODEL = "openrouter:openai/gpt-5.4-nano"

/**
 * Word-count guards for the brevity cases. The AUTHORITATIVE brevity signal is
 * the run-level ordering check (`brevity-ordering`: brief < balanced < thorough
 * on the identical prompt), which is robust to haiku's large run-to-run length
 * jitter — the whole distribution shifts ±40 words between runs while the
 * relative ordering holds. These absolute bands are only coarse runaway guards:
 * `brief` must not balloon past `BRIEF_MAX_WORDS`, `thorough` must clear
 * `THOROUGH_MIN_WORDS`. Do not tighten them toward a single run's counts — that
 * reintroduces flapping without adding signal the ordering check lacks.
 */
export const BRIEF_MAX_WORDS = 180
export const THOROUGH_MIN_WORDS = 90

/**
 * Run-level accuracy floor: fraction of cases that must pass every per-case
 * evaluator. Matches the other suites' 0.8 gate.
 */
export const STYLE_ACCURACY_GATE = 0.8
