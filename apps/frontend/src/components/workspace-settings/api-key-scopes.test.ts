import { describe, expect, it } from "vitest"
import { API_KEY_ELIGIBLE_SCOPES } from "@threahq/types"
import {
  API_KEY_SCOPE_GROUPS,
  API_KEY_SCOPE_PRESETS,
  areaLevel,
  grantedAreas,
  groupLevel,
  matchingPreset,
  withAreaLevel,
  withGroupLevel,
} from "./api-key-scopes"

const areas = API_KEY_SCOPE_GROUPS.flatMap((group) => group.areas)
const area = (id: string) => areas.find((a) => a.id === id)!
const group = (id: string) => API_KEY_SCOPE_GROUPS.find((g) => g.id === id)!

describe("API key scope areas", () => {
  it("place every key-eligible permission in exactly one area", () => {
    const placed = areas.flatMap((a) => [...a.read, ...a.write])
    expect([...placed].sort()).toEqual([...API_KEY_ELIGIBLE_SCOPES].sort())
  })

  it("give every preset whole levels, so a preset never shows an area as partly granted", () => {
    const partial = API_KEY_SCOPE_PRESETS.flatMap((preset) =>
      grantedAreas(new Set(preset.scopes))
        .filter(({ level }) => level === "partial")
        .map(({ area }) => `${preset.id}:${area.id}`)
    )
    expect(partial).toEqual([])
  })

  it("set an area's level without touching other permissions, write including read", () => {
    const start = new Set(["streams:read", "bots:manage"])
    const write = withAreaLevel(start, area("messages"), "write")
    const read = withAreaLevel(write, area("messages"), "read")
    const none = withAreaLevel(read, area("messages"), "none")
    expect({
      write: [...write].sort(),
      read: [...read].sort(),
      none: [...none].sort(),
      levels: [
        areaLevel(area("messages"), write),
        areaLevel(area("messages"), read),
        areaLevel(area("messages"), none),
      ],
    }).toEqual({
      write: ["bots:manage", "messages:read", "messages:write", "streams:read"],
      read: ["bots:manage", "messages:read", "streams:read"],
      none: ["bots:manage", "streams:read"],
      levels: ["write", "read", "none"],
    })
  })

  it("call write without read partial", () => {
    expect(areaLevel(area("messages"), new Set(["messages:write"]))).toBe("partial")
  })

  it("set a group to write, stopping read-only areas at read, and report the group's level", () => {
    const scopes = withGroupLevel(new Set<string>(), group("workspace"), "write")
    expect({
      scopes: [...scopes].sort(),
      level: groupLevel(group("workspace"), scopes),
      mixed: groupLevel(group("workspace"), withAreaLevel(scopes, area("labels"), "none")),
    }).toEqual({
      scopes: ["labels:read", "labels:write", "memos:read", "users:read"],
      level: "write",
      mixed: null,
    })
  })

  it("match a preset on key-eligible permissions only", () => {
    const connected = API_KEY_SCOPE_PRESETS.find((p) => p.id === "connected-bot")!
    expect({
      exact: matchingPreset(new Set([...connected.scopes, "bots:manage"]))?.id,
      short: matchingPreset(new Set(connected.scopes.slice(1)))?.id ?? null,
    }).toEqual({ exact: "connected-bot", short: null })
  })
})
