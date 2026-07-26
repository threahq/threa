import type { SplitSystemPrompt } from "../companion/prompt/system-prompt"
import type { ResolvedBag } from "./resolve"

/**
 * Fold a resolved ContextBag into the agent's system prompt.
 *
 * The bag's two regions land on either side of the prompt's cache boundary,
 * which is what they were always shaped for: `stable` is append-only across
 * turns, so it joins the cached region; the "Since last turn" delta is
 * re-derived every turn, so it joins the volatile tail. The intent preamble
 * (see `DiscussThreadIntent.systemPreamble`) tells the model to prefer the
 * delta's version when a message appears in both regions — still true, since
 * the delta still follows the stable region in the assembled prompt.
 *
 * Identity when `bag` is null: returns the input verbatim so bag-free
 * streams pay zero prompt cost.
 */
export function appendBagToSystemPrompt(systemPrompt: SplitSystemPrompt, bag: ResolvedBag | null): SplitSystemPrompt {
  if (!bag) return systemPrompt
  return {
    stable: [systemPrompt.stable, bag.stable].filter(Boolean).join("\n\n"),
    volatile: [systemPrompt.volatile, bag.delta].filter(Boolean).join("\n\n"),
  }
}
