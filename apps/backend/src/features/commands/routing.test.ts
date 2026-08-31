import { describe, expect, it } from "bun:test"
import { BotInvocationCapabilities, BotInvocationTriggers, BotRuntimeKinds } from "@threa/types"
import { resolveRuntimeInvocationRouting } from "./handlers"

describe("resolveRuntimeInvocationRouting", () => {
  it("routes interrupt commands to active-scratchpad for pi-local (claimable by a busy Pi)", () => {
    for (const name of ["steer", "stop", "kick", "carry-on", "reconnect", "clear", "key"]) {
      expect(resolveRuntimeInvocationRouting(name, BotRuntimeKinds.PI_LOCAL)).toEqual({
        trigger: BotInvocationTriggers.SESSION_CONTROL,
        requiredCapability: BotInvocationCapabilities.ACTIVE_SCRATCHPAD,
      })
    }
  })

  it("routes interrupt commands to session-control for the Claude Code channel and custom runtimes (a busy runtime still claims control)", () => {
    for (const name of ["steer", "stop", "kick", "carry-on", "reconnect", "clear", "key"]) {
      for (const kind of [BotRuntimeKinds.CLAUDE_CODE_CHANNEL, BotRuntimeKinds.CUSTOM]) {
        expect(resolveRuntimeInvocationRouting(name, kind)).toEqual({
          trigger: BotInvocationTriggers.SESSION_CONTROL,
          requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
        })
      }
    }
  })

  it("routes every other command to session-control regardless of runtime kind", () => {
    for (const name of ["model", "compact", "thinking", "skill", "reload", "shell", "status", "run"]) {
      for (const kind of [BotRuntimeKinds.PI_LOCAL, BotRuntimeKinds.CLAUDE_CODE_CHANNEL, BotRuntimeKinds.CUSTOM]) {
        expect(resolveRuntimeInvocationRouting(name, kind)).toEqual({
          trigger: BotInvocationTriggers.SESSION_CONTROL,
          requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
        })
      }
    }
  })
})
