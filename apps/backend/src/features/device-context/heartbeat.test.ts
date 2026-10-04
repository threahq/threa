import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { DeviceContext } from "@threahq/types"
import { storeHeartbeatDevice } from "./heartbeat"
import { UserDeviceContextRepository } from "./repository"

// A client stand-in: withTransaction runs the work under a savepoint on it.
const pool = { query: async () => ({ rows: [] }), release() {} } as unknown as Pool
const targets = [{ workspaceId: "ws_1", userId: "usr_1" }]
const phone: DeviceContext = { layout: "mobile", os: "android", installed: true }

const lockMembers = spyOn(UserDeviceContextRepository, "lockMembers")
const upsert = spyOn(UserDeviceContextRepository, "upsert")

function writes() {
  return upsert.mock.calls.map(([, members, device]) => ({ members, device }))
}

afterEach(() => {
  lockMembers.mockReset()
  upsert.mockReset()
})
afterAll(() => {
  lockMembers.mockRestore()
  upsert.mockRestore()
})

describe("storeHeartbeatDevice", () => {
  test("should write the device for every member workspace in one write when the heartbeat is interacted", async () => {
    const both = [...targets, { workspaceId: "ws_2", userId: "usr_2" }]
    lockMembers.mockResolvedValue(both)
    upsert.mockResolvedValue(undefined)
    storeHeartbeatDevice(pool, { device: phone, interacted: true }, both)
    await Bun.sleep(0)

    expect(writes()).toEqual([{ members: both, device: phone }])
  })

  test.each([
    ["the heartbeat has no interaction", { device: phone, interacted: false }],
    ["the device is absent", { device: undefined, interacted: true }],
    ["the device is off-shape", { device: { layout: "tablet", os: "ios", installed: true }, interacted: true }],
  ])("should write nothing when %s", async (_name, heartbeat) => {
    lockMembers.mockResolvedValue(targets)
    upsert.mockResolvedValue(undefined)
    storeHeartbeatDevice(pool, heartbeat, targets)
    await Bun.sleep(0)

    expect(writes()).toEqual([])
  })
})
