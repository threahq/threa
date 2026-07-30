/**
 * Context-bag configuration (INV-44).
 *
 * Lives next to the production summarizer so evals can import the same
 * constants and stay in lockstep with the deployed component.
 */

// Default model for the per-ref thread summarizer. Cheap + fast — the output
// goes into the stable region of the prompt and is cached by inputs manifest.
export const SUMMARIZER_MODEL_ID = "openrouter:openai/gpt-5.6-luna"

// Lower temperature: summaries should be deterministic so the same thread
// produces the same summary text, otherwise downstream cache thrash.
export const SUMMARIZER_TEMPERATURE = 0.2

// Hard cap on summary tokens — keep the prompt budget predictable across
// arbitrarily long source threads.
export const SUMMARIZER_MAX_TOKENS = 600
