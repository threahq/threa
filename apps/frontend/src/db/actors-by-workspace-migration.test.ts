import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { withoutWorkspace } from "@/test/workspace-rows"
import { ThreaDatabase, type CachedPersona, type CachedWorkspaceUser } from "./database"

const V12_WORKSPACE_USERS = "id, workspaceId, workosUserId, email, slug, _cachedAt"
const V4_PERSONAS = "id, workspaceId, slug, _cachedAt"

const LEGACY_STORES = ["workspaceUsers", "personas"]

function cachedUser(
  id: string,
  workspaceId: string,
  overrides: Partial<CachedWorkspaceUser> = {}
): CachedWorkspaceUser {
  return {
    id,
    workspaceId,
    workosUserId: `workos_${id}`,
    email: `${id}@example.com`,
    role: "member",
    slug: id,
    name: `${id} in ${workspaceId}`,
    description: null,
    avatarUrl: null,
    timezone: null,
    locale: null,
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: "2026-08-20T10:00:00.000Z",
    _cachedAt: 1000,
    ...overrides,
  }
}

function cachedPersona(id: string, workspaceId: string, overrides: Partial<CachedPersona> = {}): CachedPersona {
  return {
    id,
    workspaceId,
    slug: id,
    name: `${id} in ${workspaceId}`,
    description: null,
    avatarEmoji: null,
    avatarUrl: null,
    systemPrompt: null,
    model: "test-model",
    temperature: null,
    maxTokens: null,
    enabledTools: null,
    managedBy: "system",
    ownerUserId: null,
    status: "active",
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    _cachedAt: 1000,
    ...overrides,
  }
}

async function seedV53(name: string, seed: (legacy: Dexie) => Promise<void>): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(53).stores({ workspaceUsers: V12_WORKSPACE_USERS, personas: V4_PERSONAS })
  await legacy.open()
  await seed(legacy)
  legacy.close()
}

describe("v54 workspace users and personas keyed by workspace", () => {
  it("should carry rows that name a workspace to the new keys and drop the rest when upgrading from v53", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const userTwo = cachedUser("usr_2", "ws_1", { role: "admin" })
    const userOne = cachedUser("usr_1", "ws_1")
    const userOther = cachedUser("usr_3", "ws_2")
    const userOrphan = cachedUser("usr_orphan", "ws_1")

    const personaTwo = cachedPersona("persona_2", "ws_1", { managedBy: "workspace" })
    const personaOne = cachedPersona("persona_1", "ws_1")
    const personaOther = cachedPersona("persona_3", "ws_2")
    const personaOrphan = cachedPersona("persona_orphan", "ws_1")

    await seedV53(name, async (legacy) => {
      await legacy.table("workspaceUsers").bulkPut([userTwo, userOther, userOne, withoutWorkspace(userOrphan)])
      await legacy
        .table("personas")
        .bulkPut([personaTwo, personaOther, personaOne, { ...personaOrphan, workspaceId: null }])
    })

    const db = new ThreaDatabase(name)
    await db.open()

    expect({
      users: await db.workspaceUsers.toArray(),
      userByKey: await db.workspaceUsers.get(["ws_1", "usr_2"]),
      usersInWorkspace: await db.workspaceUsers.where("workspaceId").equals("ws_2").toArray(),
      userOrphan: await db.workspaceUsers.get(["ws_1", "usr_orphan"]),

      personas: await db.personas.toArray(),
      personaByKey: await db.personas.get(["ws_1", "persona_2"]),
      personasInWorkspace: await db.personas.where("workspaceId").equals("ws_1").toArray(),
      personaOrphan: await db.personas.get(["ws_1", "persona_orphan"]),

      legacyStores: db.tables.map((table) => table.name).filter((tableName) => LEGACY_STORES.includes(tableName)),
    }).toEqual({
      users: [userOne, userTwo, userOther],
      userByKey: userTwo,
      usersInWorkspace: [userOther],
      userOrphan: undefined,

      personas: [personaOne, personaTwo, personaOther],
      personaByKey: personaTwo,
      personasInWorkspace: [personaOne, personaTwo],
      personaOrphan: undefined,

      legacyStores: [],
    })

    db.close()
    await Dexie.delete(name)
  })

  it("should keep the same user id and persona id separate per workspace when written after the upgrade", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const userA = cachedUser("usr_copied", "ws_a", { name: "Ada in A" })
    const userB = cachedUser("usr_copied", "ws_b", { name: "Ada in B", role: "admin" })
    const personaA = cachedPersona("persona_system_ariadne", "ws_a", { name: "Ariadne in A" })
    const personaB = cachedPersona("persona_system_ariadne", "ws_b", { name: "Ariadne in B" })

    await seedV53(name, async (legacy) => {
      await legacy.table("workspaceUsers").put(userA)
      await legacy.table("personas").put(personaA)
    })

    const db = new ThreaDatabase(name)
    await db.open()
    await db.workspaceUsers.put(userB)
    await db.personas.put(personaB)

    const both = {
      users: await db.workspaceUsers.toArray(),
      personas: await db.personas.toArray(),
    }

    await db.workspaceUsers.delete(["ws_a", "usr_copied"])
    await db.personas.delete(["ws_a", "persona_system_ariadne"])

    expect({
      both,
      afterDeletingA: {
        users: await db.workspaceUsers.toArray(),
        personas: await db.personas.toArray(),
      },
    }).toEqual({
      both: { users: [userA, userB], personas: [personaA, personaB] },
      afterDeletingA: { users: [userB], personas: [personaB] },
    })

    db.close()
    await Dexie.delete(name)
  })
})
