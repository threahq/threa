import type { Pool } from "pg"
import { AgentToolNames, type UserPreferences } from "@threa/types"
import type { Stream } from "../streams"
import { buildStreamContext } from "./context-builder"
import { buildSystemPrompt } from "./companion/prompt/system-prompt"
import type { Persona } from "./persona-repository"
import type { BuiltInAgentConfig } from "./built-in-agents"

/**
 * Ariadne runs the *same* agent loop in the enclave as in the main app, so she
 * must run the *same* system prompt — assembled by the shared `buildSystemPrompt`
 * (temporal grounding, response style, send_message rules, tool sections, the
 * trust boundary, and the owner's scratchpad custom instructions), not the bare
 * `persona.systemPrompt`. The regional backend builds it here (it has the DB)
 * and ships the raw text to the enclave; the only inherent deltas are that I/O
 * is encrypted and the toolset is reduced.
 *
 * Tools are the one real difference: the enclave has no DB, so only the web
 * tools are available — never `workspace_research`, attachments, or memos. We
 * pass that reduced set so the prompt advertises exactly what the enclave wires.
 */
const ENCLAVE_ENABLED_TOOLS: string[] = [
  AgentToolNames.WEB_SEARCH,
  AgentToolNames.READ_URL,
  AgentToolNames.GENERAL_RESEARCH,
]

export async function buildEnclaveSystemPrompt(params: {
  pool: Pool
  stream: Stream
  /** The owner whose timezone + scratchpad custom instructions ground the prompt. */
  preferences: UserPreferences
  /** The persona (Ariadne) — its base prompt is the seed buildSystemPrompt layers on. */
  persona: BuiltInAgentConfig
}): Promise<string> {
  const { pool, stream, preferences, persona } = params

  // Same context builder the main app uses. For E2E it can't read message
  // plaintext, but the system prompt depends only on stream metadata + temporal
  // (not conversation content), so building it server-side is faithful — the
  // encrypted history is shipped separately and decrypted inside the enclave.
  const context = await buildStreamContext(pool, stream, { preferences, currentTime: new Date() })

  // Built-in config is structurally a persona; override the toolset to the
  // enclave-available subset so the prompt advertises exactly what's wired.
  // (buildSystemPrompt only reads name/systemPrompt/enabledTools; createdAt /
  // updatedAt are filled to satisfy the Persona shape.)
  const enclavePersona: Persona = {
    ...persona,
    enabledTools: ENCLAVE_ENABLED_TOOLS,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  return buildSystemPrompt(
    enclavePersona,
    context,
    preferences.scratchpadCustomPrompt,
    undefined,
    undefined,
    // No rolling conversation summary — that's derived from plaintext history
    // the backend can't read for an E2E stream.
    null,
    // workspace_research needs the DB; the enclave has none.
    false
  )
}
