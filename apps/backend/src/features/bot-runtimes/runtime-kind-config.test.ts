import { describe, expect, it } from "bun:test"
import { resolveRuntimeKindConfig } from "./runtime-kind-config"

describe("resolveRuntimeKindConfig", () => {
  it("requires a session link for pi-local and the Claude Code channel", () => {
    const pi = resolveRuntimeKindConfig("pi-local")
    const cc = resolveRuntimeKindConfig("claude-code-channel")
    expect(pi.sessionLinking).toBe("required")
    expect(cc.sessionLinking).toBe("required")
    if (cc.sessionLinking === "required") {
      const notice = cc.missingSessionLinkNotice("Scout")
      expect(notice).toContain("Scout")
      expect(notice).toContain("Claude Code")
    }
  })

  it("leaves untargeted kinds link-free", () => {
    expect(resolveRuntimeKindConfig("hermes").sessionLinking).toBe("none")
    expect(resolveRuntimeKindConfig("openclaw").sessionLinking).toBe("none")
    expect(resolveRuntimeKindConfig("custom").sessionLinking).toBe("optional")
  })

  it("defaults a bot with no runtime instance to the pi-local policy", () => {
    expect(resolveRuntimeKindConfig(null).sessionLinking).toBe("required")
  })
})
