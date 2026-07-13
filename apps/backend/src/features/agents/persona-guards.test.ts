import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { assertAssignablePersona } from "./persona-guards"
import { PersonaRepository, type Persona } from "./persona-repository"

const db = {} as never

function persona(overrides: Partial<Persona>): Persona {
  return {
    id: "persona_x",
    workspaceId: "workspace_1",
    slug: "x",
    name: "X",
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    systemPrompt: null,
    model: "m",
    escalationModel: null,
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    tonePreset: null,
    brevityPreset: null,
    tonePrompt: null,
    brevityPrompt: null,
    managedBy: "workspace",
    ownerUserId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe("assertAssignablePersona", () => {
  afterEach(() => mock.restore())

  it("is a no-op for a null/undefined pointer (clear/inherit/unchanged) — no DB read", async () => {
    const find = spyOn(PersonaRepository, "findById")
    await assertAssignablePersona(db, null, "workspace_1")
    await assertAssignablePersona(db, undefined, "workspace_1", { callerUserId: "user_a" })
    expect(find).not.toHaveBeenCalled()
  })

  it("accepts an active workspace/built-in persona with no caller context", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona({ managedBy: "workspace" }))
    await expect(assertAssignablePersona(db, "persona_x", "workspace_1")).resolves.toBeUndefined()
  })

  it("rejects an archived persona (400, does not degrade to Ariadne)", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona({ status: "archived" }))
    await expect(assertAssignablePersona(db, "persona_x", "workspace_1")).rejects.toMatchObject({
      status: 400,
      code: "PERSONA_NOT_AVAILABLE",
    })
  })

  it("rejects an unknown / foreign-workspace pointer (findById → null)", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(null)
    await expect(assertAssignablePersona(db, "persona_missing", "workspace_1")).rejects.toMatchObject({
      status: 400,
      code: "PERSONA_NOT_AVAILABLE",
    })
  })

  it("accepts a personal persona for its owner", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona({ managedBy: "user", ownerUserId: "user_owner" }))
    await expect(
      assertAssignablePersona(db, "persona_x", "workspace_1", { callerUserId: "user_owner" })
    ).resolves.toBeUndefined()
  })

  it("rejects a personal persona for a different caller (same 400 — existence not leaked)", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona({ managedBy: "user", ownerUserId: "user_owner" }))
    await expect(
      assertAssignablePersona(db, "persona_x", "workspace_1", { callerUserId: "user_other" })
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })
  })

  it("rejects a personal persona when no caller is supplied (e.g. the workspace default)", async () => {
    spyOn(PersonaRepository, "findById").mockResolvedValue(persona({ managedBy: "user", ownerUserId: "user_owner" }))
    await expect(assertAssignablePersona(db, "persona_x", "workspace_1")).rejects.toMatchObject({
      status: 400,
      code: "PERSONA_NOT_AVAILABLE",
    })
  })
})
