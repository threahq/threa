import { EFFECTS_PER_SESSION_MAX, type AgentToolEffect } from "@threa/types"

/** The one field this reads — any step shape carrying effects fits. */
type StepWithEffects = { effects?: AgentToolEffect[] }

/**
 * Aggregate a session's step effects for its lifecycle payload.
 *
 * Step order is preserved: it is the order the user watched the turn happen in.
 *
 * Writes to the same thing collapse into one entry, keyed by
 * `kind|target|label`, and the merge is what matters. "Switch me to dark —
 * actually, put it back" is two writes to `settings|theme`; keeping only the
 * first would report light → dark while the stored value is light. So the entry
 * holds the FIRST write's `before` (where the turn started) and the LAST
 * write's `after` (where it ended) — and when those are equal the turn ended
 * where it began, so there is no change to show and the diff is dropped rather
 * than rendered as a no-op.
 */
export function collectSessionEffects(steps: StepWithEffects[]): AgentToolEffect[] {
  const indexByKey = new Map<string, number>()
  const collected: AgentToolEffect[] = []

  for (const step of steps) {
    for (const effect of step.effects ?? []) {
      const key = `${effect.kind}|${effect.target ?? ""}|${effect.label ?? ""}`
      const existingIndex = indexByKey.get(key)

      if (existingIndex === undefined) {
        if (collected.length >= EFFECTS_PER_SESSION_MAX) continue
        indexByKey.set(key, collected.length)
        collected.push(effect)
        continue
      }

      const first = collected[existingIndex]!
      const merged: AgentToolEffect = { ...first }
      if (effect.after !== undefined) merged.after = effect.after
      collected[existingIndex] = merged
    }
  }

  // Dropping a cancelled-out diff has to wait until every write is folded in.
  // Doing it during the fold deletes `before` on an intermediate round-trip, and
  // a later write to the same key then merges against an entry with no starting
  // value: light→dark, dark→light, light→system would end as "→ system" instead
  // of "light → system".
  return collected.map((effect) => {
    if (effect.before === undefined || effect.before !== effect.after) return effect
    const { before: _b, after: _a, ...rest } = effect
    return rest
  })
}
