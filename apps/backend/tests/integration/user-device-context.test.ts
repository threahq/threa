import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { sql } from "../../src/db"
import { UserDeviceContextRepository } from "../../src/features/device-context"
import { userId, workspaceId } from "../../src/lib/id"

describe("UserDeviceContextRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function readUpdatedAt(wsId: string, usrId: string): Promise<string> {
    const result = await pool.query<{ updated_at: string }>(sql`
      SELECT updated_at::text FROM user_device_contexts WHERE workspace_id = ${wsId} AND user_id = ${usrId}
    `)
    return result.rows[0].updated_at
  }

  test("insert, update, unchanged report and delete", async () => {
    const wsId = workspaceId()
    const usrId = userId()

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    expect(
      await UserDeviceContextRepository.upsert(pool, wsId, usrId, { layout: "desktop", os: "linux", installed: false })
    ).toBe(true)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual({
      layout: "desktop",
      os: "linux",
      installed: false,
    })
    const insertedAt = await readUpdatedAt(wsId, usrId)

    expect(
      await UserDeviceContextRepository.upsert(pool, wsId, usrId, { layout: "desktop", os: "linux", installed: false })
    ).toBe(false)
    expect(await readUpdatedAt(wsId, usrId)).toBe(insertedAt)

    expect(
      await UserDeviceContextRepository.upsert(pool, wsId, usrId, { layout: "mobile", os: "android", installed: true })
    ).toBe(true)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual({
      layout: "mobile",
      os: "android",
      installed: true,
    })
    expect(await readUpdatedAt(wsId, usrId)).not.toBe(insertedAt)

    await UserDeviceContextRepository.delete(pool, wsId, usrId)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })

  test("keeps one row per user per workspace, isolated from other workspaces and users", async () => {
    const wsA = workspaceId()
    const wsB = workspaceId()
    const usrId = userId()
    const otherUsrId = userId()

    await UserDeviceContextRepository.upsert(pool, wsA, usrId, { layout: "mobile", os: "ios", installed: true })
    await UserDeviceContextRepository.upsert(pool, wsB, usrId, { layout: "desktop", os: "macos", installed: false })
    await UserDeviceContextRepository.upsert(pool, wsA, otherUsrId, {
      layout: "desktop",
      os: "windows",
      installed: false,
    })

    await UserDeviceContextRepository.delete(pool, wsA, usrId)

    expect(await UserDeviceContextRepository.find(pool, wsA, usrId)).toBeNull()
    expect(await UserDeviceContextRepository.find(pool, wsB, usrId)).toEqual({
      layout: "desktop",
      os: "macos",
      installed: false,
    })
    expect(await UserDeviceContextRepository.find(pool, wsA, otherUsrId)).toEqual({
      layout: "desktop",
      os: "windows",
      installed: false,
    })
  })

  test("reads a stored value this build does not know as absent", async () => {
    const wsId = workspaceId()
    const usrId = userId()
    await pool.query(sql`
      INSERT INTO user_device_contexts (workspace_id, user_id, layout, os, installed)
      VALUES (${wsId}, ${usrId}, 'tablet', 'ios', TRUE)
    `)

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })
})
