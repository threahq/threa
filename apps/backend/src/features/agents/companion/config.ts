import { BUILT_IN_AGENTS, ARIADNE_AGENT_ID } from "../built-in-agents"

export const COMPANION_MODEL_ID = BUILT_IN_AGENTS[ARIADNE_AGENT_ID].model

const ariadneTemperature = BUILT_IN_AGENTS[ARIADNE_AGENT_ID].temperature
if (ariadneTemperature == null) {
  throw new Error("Built-in Ariadne configuration is missing temperature (expected a number).")
}
export const COMPANION_TEMPERATURE = ariadneTemperature

// Model for rolling long-context summaries of dropped history
export const COMPANION_SUMMARY_MODEL_ID = "openrouter:anthropic/claude-haiku-4.5"

// Lower temperature for deterministic summary updates
export const COMPANION_SUMMARY_TEMPERATURE = 0.1

// Episode summaries (roadmap 3.1): a cheap post-completion condensation of what
// the persona did and concluded in a session, stored on the session row and
// replayed into later turns as "Previous sessions". Same small model the memo
// classifier/memorizer runs (`MEMO_CLASSIFIER_MODEL_ID`) — more capable and
// cheaper than haiku for this structured-condensation shape.
export const EPISODE_SUMMARY_MODEL_ID = "openrouter:openai/gpt-5.4-mini"
export const EPISODE_SUMMARY_TEMPERATURE = 0.1
export const EPISODE_SUMMARY_MAX_TOKENS = 256

// How many prior completed-session summaries a turn carries in its context.
export const EPISODE_SUMMARY_INJECT_COUNT = 3
