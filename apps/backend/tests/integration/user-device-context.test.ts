import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { sql } from "../../src/db"
import { UserDeviceContextRepository } from "../../src/features/device-context"
import { UserPreferencesService } from "../../src/features/user-preferences"
import { UserRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"
import type { DeviceContext } from "@threahq/types"

const laptop: DeviceContext = { layout: "desktop", os: "linux", installed: false }
const phone: DeviceContext = { layout: "mobile", os: "android", installed: true }

describe("UserDeviceContextRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedUser(wsId = workspaceId()): Promise<{ wsId: string; usrId: string }> {
    const usrId = userId()
    await pool.query(sql`
      INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name)
      VALUES (${usrId}, ${wsId}, ${`wos_${usrId}`}, ${`${usrId}@test.local`}, 'member', ${usrId}, 'Device User')
    `)
    return { wsId, usrId }
  }

  test("should keep only the latest device and delete it on request", async () => {
    const { wsId, usrId } = await seedUser()

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    await UserDeviceContextRepository.upsert(pool, wsId, usrId, laptop)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual(laptop)

    await UserDeviceContextRepository.upsert(pool, wsId, usrId, phone)
    await UserDeviceContextRepository.upsert(pool, wsId, usrId, phone)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual(phone)

    await UserDeviceContextRepository.delete(pool, wsId, usrId)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })

  test("should leave other users' devices when one user's device is deleted", async () => {
    const { wsId, usrId } = await seedUser()
    const other = await seedUser(wsId)

    await UserDeviceContextRepository.upsert(pool, wsId, usrId, phone)
    await UserDeviceContextRepository.upsert(pool, wsId, other.usrId, laptop)
    await UserDeviceContextRepository.delete(pool, wsId, usrId)

    expect({
      deleted: await UserDeviceContextRepository.find(pool, wsId, usrId),
      other: await UserDeviceContextRepository.find(pool, wsId, other.usrId),
    }).toEqual({ deleted: null, other: laptop })
  })

  test("should delete the device and refuse later reports when the user turns sharing off", async () => {
    const { wsId, usrId } = await seedUser()
    const preferences = new UserPreferencesService(pool)
    await UserDeviceContextRepository.upsert(pool, wsId, usrId, laptop)

    await preferences.updatePreferences(wsId, usrId, { shareDeviceWithAgents: false })
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    await UserDeviceContextRepository.upsert(pool, wsId, usrId, phone)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    await preferences.updatePreferences(wsId, usrId, { shareDeviceWithAgents: true })
    await UserDeviceContextRepository.upsert(pool, wsId, usrId, phone)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual(phone)
  })

  test("should refuse a report when the user is no longer a member", async () => {
    const { wsId, usrId } = await seedUser()
    await UserRepository.remove(pool, wsId, usrId)

    await UserDeviceContextRepository.upsert(pool, wsId, usrId, phone)

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })

  test("should read a stored value this build does not know as absent", async () => {
    const { wsId, usrId } = await seedUser()
    await pool.query(sql`
      INSERT INTO user_device_contexts (workspace_id, user_id, layout, os, installed)
      VALUES (${wsId}, ${usrId}, 'tablet', 'ios', TRUE)
    `)

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })
})
