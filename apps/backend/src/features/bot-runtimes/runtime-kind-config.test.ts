import { describe, expect, it } from "bun:test"
import { resolveRuntimeKindConfig } from "./runtime-kind-config"

describe("resolveRuntimeKindConfig", () => {
  it("requires a session link for pi-local, the Claude Code channel and hermes", () => {
    const pi = resolveRuntimeKindConfig("pi-local")
    const cc = resolveRuntimeKindConfig("claude-code-channel")
    expect(pi.sessionLinking).toBe("required")
    expect(cc.sessionLinking).toBe("required")
    if (cc.sessionLinking === "required") {
      const notice = cc.missingSessionLinkNotice("Scout")
      expect(notice).toContain("Scout")
      expect(notice).toContain("Claude Code")
    }

    const hermes = resolveRuntimeKindConfig("hermes")
    expect(hermes.sessionLinking).toBe("required")
    if (hermes.sessionLinking === "required") {
      const notice = hermes.missingSessionLinkNotice("Hermes bot")
      expect(notice).toContain("Hermes bot")
      expect(notice).toContain("Hermes connector")
    }
  })

  it("leaves untargeted kinds link-free", () => {
    expect(resolveRuntimeKindConfig("openclaw").sessionLinking).toBe("none")
    expect(resolveRuntimeKindConfig("custom").sessionLinking).toBe("optional")
  })

  it("defaults a bot with no runtime instance to the pi-local policy", () => {
    expect(resolveRuntimeKindConfig(null).sessionLinking).toBe("required")
  })
})
