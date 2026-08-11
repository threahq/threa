import { describe, expect, it } from "bun:test"
import type { BotRuntimeInstance } from "../bot-runtimes"
import { commandRequiresWritableAuthority, resolveAdvertisedSessionControlCommandNames } from "./availability"

function presence(capabilities: Record<string, unknown>): BotRuntimeInstance {
  return { capabilities } as BotRuntimeInstance
}

describe("command writable-authority classification", () => {
  it("exempts exactly invite, stop, and status", () => {
    expect(["invite", "stop", "status", "reconnect", "key", "unknown"].map(commandRequiresWritableAuthority)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ])
  })
})

describe("session-control command advertisement", () => {
  it("makes reconnect available only when the runtime advertises it", () => {
    expect(
      resolveAdvertisedSessionControlCommandNames(
        presence({ supportsSessionControlCommands: true, sessionControlCommands: ["stop", "reconnect"] })
      )
    ).toEqual(new Set(["stop", "reconnect"]))
    expect(
      resolveAdvertisedSessionControlCommandNames(
        presence({ supportsSessionControlCommands: true, sessionControlCommands: ["stop"] })
      )
    ).toEqual(new Set(["stop"]))
  })

  it("does not infer reconnect without the session-control capability", () => {
    expect(resolveAdvertisedSessionControlCommandNames(presence({ sessionControlCommands: ["reconnect"] }))).toEqual(
      new Set()
    )
  })
})
