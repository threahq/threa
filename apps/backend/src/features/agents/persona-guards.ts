import type { Querier } from "../../db"
import { HttpError } from "../../lib/errors"
import { PersonaRepository } from "./persona-repository"

/**
 * Assert a persona pointer references an active persona visible to this
 * workspace (a built-in or a workspace custom). `null`/`undefined` skip the
 * check — callers use them for "clear"/"inherit"/"unchanged". An archived or
 * foreign persona is a 400 rather than a silent pointer that degrades to
 * Ariadne at dispatch (INV-11). Call before opening a transaction so no
 * connection is held during the lookup (INV-41).
 */
export async function assertAssignablePersona(
  db: Querier,
  personaId: string | null | undefined,
  workspaceId: string
): Promise<void> {
  if (personaId == null) return
  const persona = await PersonaRepository.findById(db, personaId, workspaceId)
  if (!persona || persona.status !== "active") {
    throw new HttpError("Persona not available", { status: 400, code: "PERSONA_NOT_AVAILABLE" })
  }
}
