/**
 * The eval suites' throwaway persona row, executed against a real migrated
 * schema. An `ON CONFLICT` target that names no existing index is valid
 * TypeScript and valid-looking SQL; only running it finds that (INV-68).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { insertEvalPersona } from "../../evals/framework/eval-persona"
import { PersonaRepository } from "../../src/features/agents"
import { personaId } from "../../src/lib/id"

const template = {
  description: "Eval template",
  avatarEmoji: ":thread:",
  systemPrompt: "You are Ariadne.",
  enabledTools: ["send_message", "web_search"],
}

describe("eval persona insert", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("inserts a system persona carrying the permutation model", async () => {
    const id = await insertEvalPersona(pool, {
      template,
      model: "openrouter:openai/gpt-5.6-luna",
      slugPrefix: "eval-insert",
      name: "Ariadne (Eval)",
    })

    const row = await pool.query(
      `SELECT id, workspace_id, model, system_prompt, enabled_tools, managed_by, status FROM personas WHERE id = $1`,
      [id]
    )

    expect(row.rows[0]).toEqual({
      id,
      workspace_id: null,
      model: "openrouter:openai/gpt-5.6-luna",
      system_prompt: "You are Ariadne.",
      enabled_tools: ["send_message", "web_search"],
      managed_by: "system",
      status: "active",
    })
  })

  test("the ON CONFLICT target matches a real index, so a repeated slug updates the model", async () => {
    const slug = `eval-conflict-${personaId()}`
    const insert = (id: string, model: string) =>
      pool.query(
        `
        INSERT INTO personas (id, workspace_id, slug, name, description, avatar_emoji, system_prompt, model, enabled_tools, managed_by, status)
        VALUES ($1, NULL, $2, 'Ariadne (Eval)', 'd', ':thread:', 'p', $3, ARRAY['send_message'], 'system', 'active')
        ON CONFLICT (workspace_id, slug) WHERE managed_by <> 'user' DO UPDATE SET
          model = EXCLUDED.model,
          system_prompt = EXCLUDED.system_prompt
      `,
        [id, slug, model]
      )

    await insert(personaId(), "openrouter:anthropic/claude-sonnet-5")
    // NULL workspace_id makes rows distinct in this index, so both rows persist.
    await insert(personaId(), "openrouter:openai/gpt-5.6-luna")

    const rows = await pool.query(`SELECT model FROM personas WHERE slug = $1 ORDER BY model`, [slug])
    expect(rows.rows.map((r) => r.model)).toEqual([
      "openrouter:anthropic/claude-sonnet-5",
      "openrouter:openai/gpt-5.6-luna",
    ])
  })

  test("refuses a template with no system prompt rather than writing a mute persona", async () => {
    await expect(
      insertEvalPersona(pool, {
        template: { ...template, systemPrompt: null },
        model: "openrouter:openai/gpt-5.6-luna",
        slugPrefix: "eval-noprompt",
        name: "Ariadne (Eval)",
      })
    ).rejects.toThrow(/no system prompt/)
  })

  test("the row resolves through the repository the suites read it with", async () => {
    const id = await insertEvalPersona(pool, {
      template,
      model: "openrouter:openai/gpt-5.6-luna",
      slugPrefix: "eval-resolve",
      name: "Ariadne (Eval)",
    })

    const persona = await PersonaRepository.findById(pool, id, null)
    expect(persona?.model).toBe("openrouter:openai/gpt-5.6-luna")
  })
})
