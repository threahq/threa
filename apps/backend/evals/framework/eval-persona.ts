import { ulid } from "ulid"
import type { Querier } from "../../src/db"
import { personaId as generatePersonaId } from "../../src/lib/id"
import type { Persona } from "../../src/features/agents"

/**
 * Insert the throwaway persona row a companion-backed suite runs its turn as:
 * the built-in Ariadne's resolved prompt and toolset, with the permutation's
 * model swapped in.
 *
 * The `ON CONFLICT` target must name a real partial unique index on `personas`;
 * a target that matches no index throws at runtime and never at build time, so
 * this statement is executed against a migrated schema in
 * `tests/integration/eval-persona.test.ts` (INV-68).
 */
export async function insertEvalPersona(
  db: Querier,
  params: {
    /** The resolved built-in persona whose prompt and tools this row copies. */
    template: Pick<Persona, "description" | "avatarEmoji" | "systemPrompt" | "enabledTools">
    /** The permutation's model — the whole point of the row. */
    model: string
    /** Slug prefix, so a suite's rows are recognizable in a shared database. */
    slugPrefix: string
    /** Display name for the row. */
    name: string
  }
): Promise<string> {
  if (!params.template.systemPrompt) {
    throw new Error("Cannot create an eval persona from a template with no system prompt")
  }

  const id = generatePersonaId()
  await db.query(
    `
    INSERT INTO personas (id, workspace_id, slug, name, description, avatar_emoji, system_prompt, model, enabled_tools, managed_by, status)
    VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, 'system', 'active')
    ON CONFLICT (workspace_id, slug) WHERE managed_by <> 'user' DO UPDATE SET
      model = EXCLUDED.model,
      system_prompt = EXCLUDED.system_prompt
  `,
    [
      id,
      `${params.slugPrefix}-${ulid().toLowerCase().slice(0, 8)}`,
      params.name,
      params.template.description,
      params.template.avatarEmoji,
      params.template.systemPrompt,
      params.model,
      params.template.enabledTools ?? ["send_message"],
    ]
  )
  return id
}
