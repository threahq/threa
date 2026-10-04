import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { sql } from "../../src/db"
import { storeDevice, UserDeviceContextRepository } from "../../src/features/device-context"
import { UserPreferencesRepository, UserPreferencesService } from "../../src/features/user-preferences"
import { UserRepository } from "../../src/features/workspaces"
import { userId, workspaceId } from "../../src/lib/id"
import { DEFAULT_USER_PREFERENCES, type DeviceContext } from "@threahq/types"

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
    const version = async () =>
      (
        await pool.query<{ xmin: string }>(sql`
          SELECT xmin::text FROM user_device_contexts WHERE workspace_id = ${wsId} AND user_id = ${usrId}
        `)
      ).rows[0]?.xmin

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], laptop)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual(laptop)

    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)
    const changed = await version()
    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)
    expect({ device: await UserDeviceContextRepository.find(pool, wsId, usrId), version: await version() }).toEqual({
      device: phone,
      version: changed,
    })

    await UserDeviceContextRepository.delete(pool, wsId, usrId)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })

  test("should store the device for every member in one report and skip users who left or opted out", async () => {
    const first = await seedUser()
    const second = await seedUser()
    const left = await seedUser()
    const optedOut = await seedUser()
    await UserRepository.remove(pool, left.wsId, left.usrId)
    await new UserPreferencesService(pool).updatePreferences(optedOut.wsId, optedOut.usrId, {
      shareDeviceWithAgents: false,
    })

    await storeDevice(
      pool,
      [first, second, left, optedOut].map(({ wsId, usrId }) => ({ workspaceId: wsId, userId: usrId })),
      phone
    )

    expect({
      // The write treats "no override" as sharing on, so the default must stay on.
      default: DEFAULT_USER_PREFERENCES.shareDeviceWithAgents,
      first: await UserDeviceContextRepository.find(pool, first.wsId, first.usrId),
      second: await UserDeviceContextRepository.find(pool, second.wsId, second.usrId),
      left: await UserDeviceContextRepository.find(pool, left.wsId, left.usrId),
      optedOut: await UserDeviceContextRepository.find(pool, optedOut.wsId, optedOut.usrId),
    }).toEqual({ default: true, first: phone, second: phone, left: null, optedOut: null })
  })

  test("should leave other users' devices when one user's device is deleted", async () => {
    const { wsId, usrId } = await seedUser()
    const other = await seedUser(wsId)

    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)
    await storeDevice(pool, [{ workspaceId: wsId, userId: other.usrId }], laptop)
    await UserDeviceContextRepository.delete(pool, wsId, usrId)

    expect({
      deleted: await UserDeviceContextRepository.find(pool, wsId, usrId),
      other: await UserDeviceContextRepository.find(pool, wsId, other.usrId),
    }).toEqual({ deleted: null, other: laptop })
  })

  test("should delete the device and refuse later reports when the user turns sharing off", async () => {
    const { wsId, usrId } = await seedUser()
    const preferences = new UserPreferencesService(pool)
    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], laptop)

    await preferences.updatePreferences(wsId, usrId, { shareDeviceWithAgents: false })
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()

    await preferences.updatePreferences(wsId, usrId, { shareDeviceWithAgents: true })
    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)
    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toEqual(phone)
  })

  test("should not land a report that races the opt-out when the opt-out commits first", async () => {
    const { wsId, usrId } = await seedUser()
    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], laptop)

    const optOut = await pool.connect()
    try {
      await optOut.query("BEGIN")
      await UserDeviceContextRepository.lockUser(optOut, wsId, usrId)
      await UserPreferencesRepository.bulkSetOverrides(optOut, wsId, usrId, [
        { key: "shareDeviceWithAgents", value: false },
      ])
      await UserDeviceContextRepository.delete(optOut, wsId, usrId)

      const report = storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)
      await Bun.sleep(100)
      await optOut.query("COMMIT")
      await report
    } finally {
      optOut.release()
    }

    expect(await UserDeviceContextRepository.find(pool, wsId, usrId)).toBeNull()
  })

  test("should refuse a report when the user is no longer a member", async () => {
    const { wsId, usrId } = await seedUser()
    await UserRepository.remove(pool, wsId, usrId)

    await storeDevice(pool, [{ workspaceId: wsId, userId: usrId }], phone)

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
