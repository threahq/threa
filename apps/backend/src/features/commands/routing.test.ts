import { describe, expect, it } from "bun:test"
import { BotInvocationCapabilities, BotInvocationTriggers, BotRuntimeKinds } from "@threa/types"
import { resolveRuntimeInvocationRouting } from "./handlers"

describe("resolveRuntimeInvocationRouting", () => {
  it("routes steer/stop to active-scratchpad for pi-local (claimable by a busy Pi)", () => {
    for (const name of ["steer", "stop"]) {
      expect(resolveRuntimeInvocationRouting(name, BotRuntimeKinds.PI_LOCAL)).toEqual({
        trigger: BotInvocationTriggers.SESSION_CONTROL,
        requiredCapability: BotInvocationCapabilities.ACTIVE_SCRATCHPAD,
      })
    }
  })

  it("routes steer/stop to session-control for the Claude Code channel (so a busy channel still claims interrupts)", () => {
    for (const name of ["steer", "stop"]) {
      expect(resolveRuntimeInvocationRouting(name, BotRuntimeKinds.CLAUDE_CODE_CHANNEL)).toEqual({
        trigger: BotInvocationTriggers.SESSION_CONTROL,
        requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
      })
    }
  })

  it("routes every other command to session-control regardless of runtime kind", () => {
    for (const name of ["model", "compact", "thinking", "skill", "reload", "shell", "run"]) {
      for (const kind of [BotRuntimeKinds.PI_LOCAL, BotRuntimeKinds.CLAUDE_CODE_CHANNEL]) {
        expect(resolveRuntimeInvocationRouting(name, kind)).toEqual({
          trigger: BotInvocationTriggers.SESSION_CONTROL,
          requiredCapability: BotInvocationCapabilities.SESSION_CONTROL,
        })
      }
    }
  })
})
