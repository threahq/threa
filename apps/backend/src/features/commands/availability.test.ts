import { describe, expect, it } from "bun:test"
import { ASIDE_COMMAND, type CommandInfo, type StreamType } from "@threa/types"
import type { BotRuntimeInstance } from "../bot-runtimes"
import type { Stream } from "../streams"
import {
  commandRequiresWritableAuthority,
  isClientActionAvailableInStream,
  resolveAdvertisedSessionControlCommandNames,
} from "./availability"
import { listClientActionCommandInfos } from "./catalog"

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

describe("client-action command availability", () => {
  const aside = listClientActionCommandInfos().find((info) => info.clientActionId === ASIDE_COMMAND) as CommandInfo
  const stream = (type: StreamType, overrides: Partial<Stream> = {}): Stream =>
    ({ id: `stream_${type}`, type, ...overrides }) as Stream

  it("offers /aside on channel, dm, scratchpad and thread hosts only", () => {
    const types: StreamType[] = ["channel", "dm", "scratchpad", "thread", "system", "aside"]
    expect(types.map((type) => isClientActionAvailableInStream(aside, stream(type)))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it("never offers /aside on a read-only (archived) host", () => {
    expect(isClientActionAvailableInStream(aside, stream("channel"), { writable: false })).toBe(false)
    expect(isClientActionAvailableInStream(aside, stream("channel"), { writable: true })).toBe(true)
  })

  it("never offers /aside on an end-to-end encrypted host", () => {
    expect(isClientActionAvailableInStream(aside, stream("scratchpad", { e2eEnabled: true }))).toBe(false)
  })

  it("is the only client action left in the catalog", () => {
    expect(listClientActionCommandInfos().map((info) => info.clientActionId)).toEqual([ASIDE_COMMAND])
  })
})
