/**
 * Model ids → the name a reader recognises: `openrouter:anthropic/claude-opus-5`
 * → "Claude Opus 5". One helper, every surface (subagent card, model badge,
 * trace steps).
 *
 * Derived from the id rather than fetched: the registry's own `name` reaches the
 * client only through the admin-only persona-config response, so a card every
 * stream member can see cannot read it, and the alternative — a fetch per card —
 * is exactly what the payload-carried timeline exists to avoid. The backend
 * still sends only the id (INV-46); the formatting lives here.
 *
 * `model-display.test.ts` holds the derivation to the registry: it re-derives
 * every chat model in `packages/agent-runtime/src/ai/models.yaml` and fails if a
 * name and this function disagree, so a model whose branding breaks the pattern
 * is caught when it is added, not by a reader.
 */

const ACRONYMS: Record<string, string> = { gpt: "GPT", ai: "AI" }

/** Tokens that brand as `NAME-<version>` rather than `Name <version>`. */
const HYPHENATED = new Set(["GPT"])

function capitalize(token: string): string {
  const acronym = ACRONYMS[token]
  if (acronym) return acronym
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * The display name for a model id. Unknown ids degrade to their formatted slug,
 * which stays readable, so a model added ahead of this map never renders raw.
 */
export function modelDisplayName(modelId: string): string {
  const slug = (modelId.split(":").pop() ?? modelId).split("/").pop() ?? modelId
  const tokens = slug.split("-").filter(Boolean).map(capitalize)
  if (tokens.length === 0) return modelId
  return tokens.reduce((name, token, index) => {
    if (index === 0) return token
    return HYPHENATED.has(tokens[index - 1]) ? `${name}-${token}` : `${name} ${token}`
  }, "")
}
