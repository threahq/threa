import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { Pool } from "pg"
import { setupTestDatabase, addTestMember } from "./setup"
import { PeoplePurposes, WorkspaceRepository, UserRepository } from "../../src/features/workspaces"
import { createPublicApiAuthMiddleware } from "../../src/middleware/public-api-auth"
import type { HttpError } from "../../src/lib/errors"
import { userId, workspaceId } from "../../src/lib/id"

async function seedWorkspace(pool: Pool) {
  const ownerWorkosUserId = userId()
  const wsId = workspaceId()
  await WorkspaceRepository.insert(pool, {
    id: wsId,
    name: "Unclaimed Users Workspace",
    slug: `unclaimed-${wsId}`,
    createdBy: ownerWorkosUserId,
  })
  const owner = await addTestMember(pool, wsId, ownerWorkosUserId, "owner")
  return { wsId, owner }
}

function insertUnclaimed(pool: Pool, wsId: string, name: string) {
  const id = userId()
  return UserRepository.insert(pool, {
    id,
    workspaceId: wsId,
    workosUserId: null,
    email: null,
    name,
    role: "member",
    slug: `unclaimed-${id}`,
  })
}

describe("unclaimed users", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should list unclaimed users alongside members when a workspace holds several", async () => {
    const { wsId, owner } = await seedWorkspace(pool)
    const alice = await insertUnclaimed(pool, wsId, "Alice")
    const bob = await insertUnclaimed(pool, wsId, "Bob")

    const users = await UserRepository.listByWorkspace(pool, wsId, {
      viewer: { kind: "user", userId: owner.id },
      purpose: PeoplePurposes.VISIBLE,
    })

    expect(users.map((u) => ({ id: u.id, workosUserId: u.workosUserId, email: u.email, role: u.role }))).toEqual(
      expect.arrayContaining([
        { id: owner.id, workosUserId: owner.workosUserId, email: owner.email, role: "owner" },
        { id: alice.id, workosUserId: null, email: null, role: "member" },
        { id: bob.id, workosUserId: null, email: null, role: "member" },
      ])
    )
  })

  test("should refuse a user API key when its owner is unclaimed", async () => {
    const { wsId } = await seedWorkspace(pool)
    const dana = await insertUnclaimed(pool, wsId, "Dana")
    const middleware = createPublicApiAuthMiddleware({
      userApiKeyService: {
        validateKey: async () => ({
          id: "uak_test",
          workspaceId: wsId,
          userId: dana.id,
          scopes: new Set(["messages:read"]),
        }),
      } as never,
      botApiKeyService: { validateKey: async () => null } as never,
      sandboxSessionTokenService: { validate: async () => null } as never,
      workspaceAuthzService: { resolveActivePermissions: async () => ["messages:read"] } as never,
      pool,
    })
    const req = {
      headers: { authorization: "Bearer threa_uk_test" },
      params: { workspaceId: wsId },
    } as unknown as Request

    let error: HttpError | undefined
    const next: NextFunction = (err?: unknown) => {
      error = err as HttpError | undefined
    }
    await middleware(req, {} as Response, next)

    expect({ status: error?.status, code: error?.code, user: req.user }).toEqual({
      status: 403,
      code: "FORBIDDEN",
      user: undefined,
    })
  })
})
