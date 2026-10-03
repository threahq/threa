import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import type { DeviceContext } from "@threahq/types"
import { DeviceHeartbeatSync } from "./heartbeat-sync"
import { UserDeviceContextRepository } from "./repository"

const pool = {} as Pool
const targets = [{ workspaceId: "ws_1", userId: "usr_1" }]
const phone: DeviceContext = { layout: "mobile", os: "android", installed: true }
const laptop: DeviceContext = { layout: "desktop", os: "linux", installed: false }

const upsert = spyOn(UserDeviceContextRepository, "upsert")

function writes() {
  return upsert.mock.calls.map(([, workspaceId, userId, device]) => ({ workspaceId, userId, device }))
}

afterEach(() => upsert.mockReset())
afterAll(() => upsert.mockRestore())

describe("DeviceHeartbeatSync", () => {
  test("writes the device on an interacted heartbeat", () => {
    upsert.mockResolvedValue(true)
    new DeviceHeartbeatSync(pool).handle({ device: phone, interacted: true }, targets)

    expect(writes()).toEqual([{ workspaceId: "ws_1", userId: "usr_1", device: phone }])
  })

  test("ignores a heartbeat without interaction", () => {
    upsert.mockResolvedValue(true)
    new DeviceHeartbeatSync(pool).handle({ device: phone, interacted: false }, targets)

    expect(writes()).toEqual([])
  })

  test("writes again only when the device changed", () => {
    upsert.mockResolvedValue(true)
    const sync = new DeviceHeartbeatSync(pool)
    sync.handle({ device: phone, interacted: true }, targets)
    sync.handle({ device: { ...phone }, interacted: true }, targets)
    sync.handle({ device: laptop, interacted: true }, targets)

    expect(writes().map((w) => w.device)).toEqual([phone, laptop])
  })

  test("writes for every workspace the connection serves", () => {
    upsert.mockResolvedValue(true)
    new DeviceHeartbeatSync(pool).handle({ device: phone, interacted: true }, [
      ...targets,
      { workspaceId: "ws_2", userId: "usr_2" },
    ])

    expect(writes()).toEqual([
      { workspaceId: "ws_1", userId: "usr_1", device: phone },
      { workspaceId: "ws_2", userId: "usr_2", device: phone },
    ])
  })

  test.each([
    ["absent", undefined],
    ["off-shape", { layout: "tablet", os: "ios", installed: true }],
  ])("a %s device writes nothing and lets the same device be written again later", (_name, bad) => {
    upsert.mockResolvedValue(true)
    const sync = new DeviceHeartbeatSync(pool)
    sync.handle({ device: phone, interacted: true }, targets)
    sync.handle({ device: bad, interacted: true }, targets)
    sync.handle({ device: phone, interacted: true }, targets)

    expect(writes().map((w) => w.device)).toEqual([phone, phone])
  })

  test("retries after a failed write", async () => {
    upsert.mockRejectedValueOnce(new Error("db down")).mockResolvedValue(true)
    const sync = new DeviceHeartbeatSync(pool)
    sync.handle({ device: phone, interacted: true }, targets)
    await new Promise((resolve) => setTimeout(resolve, 0))
    sync.handle({ device: phone, interacted: true }, targets)

    expect(writes().map((w) => w.device)).toEqual([phone, phone])
  })
})
