import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { DeviceContext } from "@threahq/types"
import { storeHeartbeatDevice } from "./heartbeat"
import { UserDeviceContextRepository } from "./repository"

const pool = {} as Pool
const targets = [{ workspaceId: "ws_1", userId: "usr_1" }]
const phone: DeviceContext = { layout: "mobile", os: "android", installed: true }

const upsert = spyOn(UserDeviceContextRepository, "upsert")

function writes() {
  return upsert.mock.calls.map(([, workspaceId, userId, device]) => ({ workspaceId, userId, device }))
}

afterEach(() => upsert.mockReset())
afterAll(() => upsert.mockRestore())

describe("storeHeartbeatDevice", () => {
  test("should write the device for every workspace when the heartbeat is interacted", () => {
    upsert.mockResolvedValue(undefined)
    storeHeartbeatDevice(pool, { device: phone, interacted: true }, [
      ...targets,
      { workspaceId: "ws_2", userId: "usr_2" },
    ])

    expect(writes()).toEqual([
      { workspaceId: "ws_1", userId: "usr_1", device: phone },
      { workspaceId: "ws_2", userId: "usr_2", device: phone },
    ])
  })

  test.each([
    ["the heartbeat has no interaction", { device: phone, interacted: false }],
    ["the device is absent", { device: undefined, interacted: true }],
    ["the device is off-shape", { device: { layout: "tablet", os: "ios", installed: true }, interacted: true }],
  ])("should write nothing when %s", (_name, heartbeat) => {
    upsert.mockResolvedValue(undefined)
    storeHeartbeatDevice(pool, heartbeat, targets)

    expect(writes()).toEqual([])
  })
})
