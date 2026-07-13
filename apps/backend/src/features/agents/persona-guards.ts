import type { Querier } from "../../db"
import { HttpError } from "../../lib/errors"
import { PersonaRepository } from "./persona-repository"

/**
 * Assert a persona pointer references an active persona the caller may assign (a
 * built-in, a workspace custom, or the caller's OWN personal persona).
 * `null`/`undefined` skip the check — callers use them for
 * "clear"/"inherit"/"unchanged". An archived, foreign, or another user's
 * personal persona is a 400 rather than a silent pointer that degrades to
 * Ariadne at dispatch (INV-11). Call before opening a transaction so no
 * connection is held during the lookup (INV-41).
 *
 * A personal (`managed_by = 'user'`) persona is assignable only when
 * `opts.callerUserId` is its owner (user-scoped-personas). Callers that must
 * never accept a personal persona (e.g. the workspace default) omit
 * `callerUserId`, so any personal persona fails the check. The error code is the
 * same 400 `PERSONA_NOT_AVAILABLE` whether the persona is archived, foreign, or
 * another user's personal one — existence of a personal persona is not leaked.
 */
export async function assertAssignablePersona(
  db: Querier,
  personaId: string | null | undefined,
  workspaceId: string,
  opts?: { callerUserId?: string }
): Promise<void> {
  if (personaId == null) return
  const persona = await PersonaRepository.findById(db, personaId, workspaceId)
  if (!persona || persona.status !== "active") {
    throw new HttpError("Persona not available", { status: 400, code: "PERSONA_NOT_AVAILABLE" })
  }
  if (persona.managedBy === "user" && persona.ownerUserId !== opts?.callerUserId) {
    throw new HttpError("Persona not available", { status: 400, code: "PERSONA_NOT_AVAILABLE" })
  }
}
