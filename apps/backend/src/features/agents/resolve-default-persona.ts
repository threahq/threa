import type { UserPreferences, WorkspaceSettings } from "@threahq/types"
import type { Querier } from "../../db"
import { UserPreferencesRepository } from "../user-preferences"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import { PersonaRepository, type Persona } from "./persona-repository"

/**
 * The one KV key both the user-preference and workspace-setting stores use for
 * the default companion persona pointer. `satisfies` ties it to the shared field
 * name so a rename in either type surfaces here (INV-31/33).
 */
const DEFAULT_COMPANION_PERSONA_KEY = "defaultCompanionPersonaId" satisfies keyof UserPreferences &
  keyof WorkspaceSettings

/**
 * Resolve the persona a companion turn should run when a scratchpad carries no
 * explicit pick. Precedence (brief §Settled decision 2): the owning user's
 * preference → the workspace setting → built-in Ariadne.
 *
 * Each tier degrades to the next when its stored pointer is missing, points at a
 * persona that no longer resolves in this workspace, or resolves to a non-active
 * (archived/disabled) persona. This resolve-time tolerance is the ONE sanctioned
 * silent fallback (INV-11): write-time `assertAssignablePersona` already rejects
 * pointers that aren't active-in-workspace, so a stale pointer here means the
 * persona was archived *after* it was chosen — degrade rather than abort the turn.
 *
 * `ownerUserId` omitted (or the user tier absent) skips straight to the workspace
 * setting. Returns null only if even Ariadne is unavailable.
 */
export async function resolveDefaultPersona(
  db: Querier,
  workspaceId: string,
  ownerUserId?: string
): Promise<Persona | null> {
  if (ownerUserId) {
    const userOverride = await UserPreferencesRepository.findOverride(db, ownerUserId, DEFAULT_COMPANION_PERSONA_KEY)
    const userPersona = await resolvePointer(db, userOverride?.value, workspaceId)
    if (userPersona) return userPersona
  }

  const workspaceOverride = await WorkspaceSettingsRepository.findOverride(
    db,
    workspaceId,
    DEFAULT_COMPANION_PERSONA_KEY
  )
  const workspacePersona = await resolvePointer(db, workspaceOverride?.value, workspaceId)
  if (workspacePersona) return workspacePersona

  return PersonaRepository.getSystemDefault(db, workspaceId)
}

/** A stored pointer resolves only when it is a string id for an active persona in the workspace. */
async function resolvePointer(db: Querier, value: unknown, workspaceId: string): Promise<Persona | null> {
  if (typeof value !== "string" || value.length === 0) return null
  const persona = await PersonaRepository.findById(db, value, workspaceId)
  return persona?.status === "active" ? persona : null
}
