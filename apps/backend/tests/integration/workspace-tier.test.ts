import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { WorkspaceRepository, createWorkspaceTierSyncHandlers } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"

function mockRes() {
  const res = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code
      return res
    },
    send() {
      return res
    },
  }
  return res
}

describe("workspace tier sync endpoint", () => {
  let pool: Pool
  let handlers: ReturnType<typeof createWorkspaceTierSyncHandlers>
  const workspaces: string[] = []

  beforeAll(async () => {
    pool = await setupTestDatabase()
    handlers = createWorkspaceTierSyncHandlers({ pool })
  })

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = ANY($1)", [workspaces])
    await pool.end()
  })

  async function seedWorkspace(): Promise<string> {
    const id = workspaceId()
    workspaces.push(id)
    await WorkspaceRepository.insert(pool, { id, name: "Tier", slug: `tier-${id}`, createdBy: userId() })
    return id
  }

  async function sync(body: unknown) {
    const res = mockRes()
    await handlers.sync({ body } as never, res as never)
    return res.statusCode
  }

  async function storedTier(id: string) {
    return (await WorkspaceRepository.findById(pool, id))?.tier
  }

  test("should default a new workspace to full and update the tier idempotently", async () => {
    const id = await seedWorkspace()

    const before = await storedTier(id)
    const statuses = [
      await sync({ workspaceId: id, tier: "connect" }),
      await sync({ workspaceId: id, tier: "connect" }),
    ]
    const connect = await storedTier(id)
    statuses.push(await sync({ workspaceId: id, tier: "full" }))

    expect({ before, statuses, connect, after: await storedTier(id) }).toEqual({
      before: "full",
      statuses: [204, 204, 204],
      connect: "connect",
      after: "full",
    })
  })

  test("should answer 404 for a workspace this region does not hold", async () => {
    await expect(sync({ workspaceId: "ws_missing", tier: "connect" })).rejects.toMatchObject({
      status: 404,
      code: "WORKSPACE_NOT_FOUND",
    })
  })

  test("should reject a tier outside the list or an extra field without writing", async () => {
    const id = await seedWorkspace()

    const rejections = await Promise.all(
      [
        { workspaceId: id, tier: "enterprise" },
        { workspaceId: id, tier: "connect", extra: true },
        { workspaceId: id },
      ].map((body) => sync(body).catch((error: unknown) => error))
    )

    expect({ rejections, stored: await storedTier(id) }).toEqual({
      rejections: [1, 2, 3].map(() => expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" })),
      stored: "full",
    })
  })
})
