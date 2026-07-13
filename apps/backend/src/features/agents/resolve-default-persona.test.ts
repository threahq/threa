import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { UserPreferencesRepository } from "../user-preferences"
import { WorkspaceSettingsRepository } from "../workspace-settings"
import { PersonaRepository, type Persona } from "./persona-repository"
import { resolveDefaultPersona } from "./resolve-default-persona"

const WORKSPACE_ID = "workspace_1"
const OWNER_ID = "usr_owner"
const db = {} as any

function persona(id: string, status: Persona["status"] = "active"): Persona {
  return { id, status } as Persona
}

/** Point a repo's single-key read at a stored value (or null = no override). */
function stubUserOverride(value: unknown | null) {
  return spyOn(UserPreferencesRepository, "findOverride").mockResolvedValue(
    value === null ? null : { key: "defaultCompanionPersonaId", value }
  )
}
function stubWorkspaceOverride(value: unknown | null) {
  return spyOn(WorkspaceSettingsRepository, "findOverride").mockResolvedValue(
    value === null ? null : { key: "defaultCompanionPersonaId", value }
  )
}

describe("resolveDefaultPersona", () => {
  afterEach(() => {
    mock.restore()
  })

  it("prefers the user preference over the workspace setting", async () => {
    stubUserOverride("persona_user")
    stubWorkspaceOverride("persona_workspace")
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue(persona("persona_user"))
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault")

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(persona("persona_user"))
    expect(findById).toHaveBeenCalledWith(db, "persona_user", WORKSPACE_ID)
    expect(systemDefault).not.toHaveBeenCalled()
  })

  it("resolves the owner's personal persona as their personal default (user tier, findById returns it active)", async () => {
    // The stored pointer was owner-validated at write time (assertAssignablePersona
    // with the caller's id), so a personal id can legitimately sit in the user
    // tier; findById is workspace-scoped and returns the personal row.
    const personal = { id: "persona_personal", status: "active", managedBy: "user", ownerUserId: OWNER_ID } as Persona
    stubUserOverride("persona_personal")
    stubWorkspaceOverride("persona_workspace")
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue(personal)
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault")

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(personal)
    expect(findById).toHaveBeenCalledWith(db, "persona_personal", WORKSPACE_ID)
    expect(systemDefault).not.toHaveBeenCalled()
  })

  it("uses the workspace setting when the user preference is absent", async () => {
    stubUserOverride(null)
    stubWorkspaceOverride("persona_workspace")
    const findById = spyOn(PersonaRepository, "findById").mockResolvedValue(persona("persona_workspace"))
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault")

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(persona("persona_workspace"))
    expect(findById).toHaveBeenCalledWith(db, "persona_workspace", WORKSPACE_ID)
    expect(systemDefault).not.toHaveBeenCalled()
  })

  it("falls to Ariadne when neither the user preference nor the workspace setting is set", async () => {
    stubUserOverride(null)
    stubWorkspaceOverride(null)
    const findById = spyOn(PersonaRepository, "findById")
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault").mockResolvedValue(persona("persona_ariadne"))

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(persona("persona_ariadne"))
    expect(findById).not.toHaveBeenCalled()
    expect(systemDefault).toHaveBeenCalledWith(db, WORKSPACE_ID)
  })

  it("degrades a user preference pointing at an archived persona to the workspace setting", async () => {
    stubUserOverride("persona_user_archived")
    stubWorkspaceOverride("persona_workspace")
    spyOn(PersonaRepository, "findById").mockImplementation(async (_db: any, id: string) =>
      id === "persona_user_archived" ? persona("persona_user_archived", "archived") : persona("persona_workspace")
    )
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault")

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(persona("persona_workspace"))
    expect(systemDefault).not.toHaveBeenCalled()
  })

  it("degrades an archived workspace setting to Ariadne", async () => {
    stubUserOverride(null)
    stubWorkspaceOverride("persona_workspace_archived")
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona("persona_workspace_archived", "archived"))
    const systemDefault = spyOn(PersonaRepository, "getSystemDefault").mockResolvedValue(persona("persona_ariadne"))

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(persona("persona_ariadne"))
    expect(systemDefault).toHaveBeenCalledWith(db, WORKSPACE_ID)
  })

  it("degrades a user preference pointing at a no-longer-resolving persona to the workspace setting", async () => {
    stubUserOverride("persona_gone")
    stubWorkspaceOverride("persona_workspace")
    spyOn(PersonaRepository, "findById").mockImplementation(async (_db: any, id: string) =>
      id === "persona_gone" ? null : persona("persona_workspace")
    )

    const result = await resolveDefaultPersona(db, WORKSPACE_ID, OWNER_ID)

    expect(result).toEqual(persona("persona_workspace"))
  })

  it("skips the user tier entirely when ownerUserId is omitted", async () => {
    const userOverride = spyOn(UserPreferencesRepository, "findOverride")
    stubWorkspaceOverride("persona_workspace")
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona("persona_workspace"))

    const result = await resolveDefaultPersona(db, WORKSPACE_ID)

    expect(result).toEqual(persona("persona_workspace"))
    expect(userOverride).not.toHaveBeenCalled()
  })
})
