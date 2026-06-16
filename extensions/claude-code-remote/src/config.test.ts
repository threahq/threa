import { describe, expect, test } from "bun:test"
import { defaultDisplayName, deriveStableId, loadConfig, sanitizeId } from "./config"

const ID_CHARSET = /^[A-Za-z0-9_-]+$/

describe("deriveStableId", () => {
  test("is deterministic for the same seed and prefixed", () => {
    const a = deriveStableId("cc", "host:/Users/kris/dev/threa")
    const b = deriveStableId("cc", "host:/Users/kris/dev/threa")
    expect(a).toBe(b)
    expect(a.startsWith("cc-")).toBe(true)
  })

  test("differs for different seeds", () => {
    expect(deriveStableId("cc", "host:/a")).not.toBe(deriveStableId("cc", "host:/b"))
  })

  test("stays within the hello-schema charset and 64-char cap", () => {
    const id = deriveStableId("ccs", "kristoffers-mbp.lan:/Users/kris/dev/threa")
    expect(id).toMatch(ID_CHARSET)
    expect(id.length).toBeLessThanOrEqual(64)
  })
})

describe("sanitizeId", () => {
  test("replaces unsafe chars and trims separators", () => {
    expect(sanitizeId("kristoffers-mbp.lan")).toBe("kristoffers-mbp-lan")
    expect(sanitizeId("--abc--")).toBe("abc")
    expect(sanitizeId("a..b..c")).toBe("a-b-c")
  })
})

describe("defaultDisplayName", () => {
  test("appends the project dir to a default prefix", () => {
    expect(defaultDisplayName("/Users/kris/dev/threa")).toBe("Claude Code - threa")
  })
  test("uses a configured override as the prefix", () => {
    expect(defaultDisplayName("/Users/kris/dev/threa", "Work")).toBe("Work - threa")
  })
  test("ignores a trailing slash and clamps to 100 chars", () => {
    expect(defaultDisplayName("/Users/kris/dev/threa/")).toBe("Claude Code - threa")
    expect(defaultDisplayName("/a", "x".repeat(200)).length).toBe(100)
  })
})

describe("loadConfig", () => {
  const base = { cwd: "/Users/kris/dev/threa", hostname: "host" }

  test("errors when required credentials are missing", () => {
    const result = loadConfig({ ...base, env: {} })
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("THREA_WORKSPACE_ID")
      expect(result.error).toContain("THREA_API_KEY")
    }
  })

  test("resolves from env and derives stable ids", () => {
    const result = loadConfig({
      ...base,
      env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" },
    })
    expect("config" in result).toBe(true)
    if ("config" in result) {
      expect(result.config.workspaceId).toBe("ws_1")
      expect(result.config.apiKey).toBe("threa_bk_x")
      expect(result.config.baseUrl).toBe("https://app.threa.io")
      expect(result.config.instanceId).toMatch(ID_CHARSET)
      expect(result.config.runtimeSessionId).toMatch(ID_CHARSET)
      expect(result.config.permissionRelay).toBe(true)
      // Same host+cwd resolves to the same scratchpad on the next launch.
      const again = loadConfig({ ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" } })
      if ("config" in again) expect(again.config.instanceId).toBe(result.config.instanceId)
    }
  })

  test("appends the project dir to the display name (default prefix and override)", () => {
    const def = loadConfig({ ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" } })
    if ("config" in def) expect(def.config.displayName).toBe("Claude Code - threa")
    const override = loadConfig({
      ...base,
      env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x", THREA_DISPLAY_NAME: "Work" },
    })
    if ("config" in override) expect(override.config.displayName).toBe("Work - threa")
  })

  test("env overrides file values", () => {
    const result = loadConfig({
      ...base,
      env: { THREA_WORKSPACE_ID: "ws_env", THREA_API_KEY: "threa_bk_env" },
      file: { workspaceId: "ws_file", apiKey: "threa_bk_file", baseUrl: "https://staging.threa.io" },
    })
    if ("config" in result) {
      expect(result.config.workspaceId).toBe("ws_env")
      expect(result.config.baseUrl).toBe("https://staging.threa.io")
    }
  })

  test("parses permissionRelay off and clamps pollMs", () => {
    const result = loadConfig({
      ...base,
      env: {
        THREA_WORKSPACE_ID: "ws_1",
        THREA_API_KEY: "threa_bk_x",
        THREA_PERMISSION_RELAY: "0",
        THREA_POLL_MS: "10",
      },
    })
    if ("config" in result) {
      expect(result.config.permissionRelay).toBe(false)
      expect(result.config.pollMs).toBe(1000)
    }
  })

  test("honors explicit instanceId / runtimeSessionId overrides", () => {
    const result = loadConfig({
      ...base,
      env: {
        THREA_WORKSPACE_ID: "ws_1",
        THREA_API_KEY: "threa_bk_x",
        THREA_INSTANCE_ID: "my.instance",
        THREA_RUNTIME_SESSION_ID: "my.session",
      },
    })
    if ("config" in result) {
      expect(result.config.instanceId).toBe("my-instance")
      expect(result.config.runtimeSessionId).toBe("my-session")
    }
  })
})
