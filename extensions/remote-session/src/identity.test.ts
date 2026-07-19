import { describe, expect, test } from "bun:test"
import { defaultDisplayName, deriveStableId, loadConfig, sanitizeId, type ConnectorIdentity } from "./identity"

const IDENTITY: ConnectorIdentity = {
  idPrefix: "cc",
  sessionIdPrefix: "ccs",
  displayNamePrefix: "Claude Code",
  configPathHint: "~/.claude/threa-channel/config.json",
}

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
    expect(defaultDisplayName("/Users/kris/dev/threa", "Claude Code")).toBe("Claude Code - threa")
  })
  test("uses a configured override as the prefix", () => {
    expect(defaultDisplayName("/Users/kris/dev/threa", "Claude Code", "Work")).toBe("Work - threa")
  })
  test("ignores a trailing slash and clamps to 100 chars", () => {
    expect(defaultDisplayName("/Users/kris/dev/threa/", "Claude Code")).toBe("Claude Code - threa")
    expect(defaultDisplayName("/a", "Claude Code", "x".repeat(200)).length).toBe(100)
  })
})

describe("loadConfig", () => {
  const base = { cwd: "/Users/kris/dev/threa", hostname: "host" }

  test("errors when required credentials are missing", () => {
    const result = loadConfig({ ...base, env: {} }, IDENTITY)
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error).toContain("THREA_WORKSPACE_ID")
      expect(result.error).toContain("THREA_API_KEY")
    }
  })

  test("resolves from env and derives stable ids", () => {
    const result = loadConfig(
      {
        ...base,
        env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" },
      },
      IDENTITY
    )
    expect("config" in result).toBe(true)
    if ("config" in result) {
      expect(result.config.workspaceId).toBe("ws_1")
      expect(result.config.apiKey).toBe("threa_bk_x")
      expect(result.config.baseUrl).toBe("https://app.threa.io")
      expect(result.config.instanceId).toMatch(ID_CHARSET)
      expect(result.config.runtimeSessionId).toMatch(ID_CHARSET)
      expect(result.config.permissionRelay).toBe(true)
      expect(result.config.coldStartIfArchived).toBe("replace")
      expect(result.config.coldStartIfMissing).toBe("create")
      expect(result.config.delegations).toBe(false)
      // Same host+cwd resolves to the same scratchpad on the next launch.
      const again = loadConfig({ ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" } }, IDENTITY)
      if ("config" in again) expect(again.config.instanceId).toBe(result.config.instanceId)
    }
  })

  test("appends the project dir to the display name (default prefix and override)", () => {
    const def = loadConfig({ ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" } }, IDENTITY)
    if ("config" in def) expect(def.config.displayName).toBe("Claude Code - threa")
    const override = loadConfig(
      {
        ...base,
        env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x", THREA_DISPLAY_NAME: "Work" },
      },
      IDENTITY
    )
    if ("config" in override) expect(override.config.displayName).toBe("Work - threa")
  })

  test("env overrides file values", () => {
    const result = loadConfig(
      {
        ...base,
        env: { THREA_WORKSPACE_ID: "ws_env", THREA_API_KEY: "threa_bk_env" },
        file: { workspaceId: "ws_file", apiKey: "threa_bk_file", baseUrl: "https://staging.threa.io" },
      },
      IDENTITY
    )
    if ("config" in result) {
      expect(result.config.workspaceId).toBe("ws_env")
      expect(result.config.baseUrl).toBe("https://staging.threa.io")
    }
  })

  test("resolves defaultLabel from env (winning over file) and is undefined when unset", () => {
    const unset = loadConfig({ ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" } }, IDENTITY)
    if ("config" in unset) expect(unset.config.defaultLabel).toBeUndefined()

    const fromFile = loadConfig(
      {
        ...base,
        env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" },
        file: { defaultLabel: "coding" },
      },
      IDENTITY
    )
    if ("config" in fromFile) expect(fromFile.config.defaultLabel).toBe("coding")

    const envWins = loadConfig(
      {
        ...base,
        env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x", THREA_DEFAULT_LABEL: " review " },
        file: { defaultLabel: "coding" },
      },
      IDENTITY
    )
    if ("config" in envWins) expect(envWins.config.defaultLabel).toBe("review")
  })

  test("allows a supervisor to force wait-only cold starts", () => {
    const result = loadConfig(
      {
        ...base,
        env: {
          THREA_WORKSPACE_ID: "ws_1",
          THREA_API_KEY: "threa_bk_x",
          THREA_COLD_START_IF_ARCHIVED: "wait",
          THREA_COLD_START_IF_MISSING: "error",
          THREA_EXPECTED_ROOT_STREAM_ID: "stream_expected",
        },
      },
      IDENTITY
    )
    expect("config" in result).toBe(true)
    if ("config" in result) {
      expect(result.config.coldStartIfArchived).toBe("wait")
      expect(result.config.coldStartIfMissing).toBe("error")
      expect(result.config.expectedRootStreamId).toBe("stream_expected")
    }
  })

  test("empty supervisor env values retain file policies", () => {
    const result = loadConfig(
      {
        ...base,
        env: {
          THREA_WORKSPACE_ID: "ws_1",
          THREA_API_KEY: "threa_bk_x",
          THREA_COLD_START_IF_ARCHIVED: " ",
          THREA_COLD_START_IF_MISSING: "",
        },
        file: { coldStartIfArchived: "wait", coldStartIfMissing: "error" },
      },
      IDENTITY
    )
    expect("config" in result).toBe(true)
    if ("config" in result) {
      expect(result.config.coldStartIfArchived).toBe("wait")
      expect(result.config.coldStartIfMissing).toBe("error")
    }
  })

  test("parses permissionRelay off and clamps pollMs", () => {
    const result = loadConfig(
      {
        ...base,
        env: {
          THREA_WORKSPACE_ID: "ws_1",
          THREA_API_KEY: "threa_bk_x",
          THREA_PERMISSION_RELAY: "0",
          THREA_POLL_MS: "10",
        },
      },
      IDENTITY
    )
    if ("config" in result) {
      expect(result.config.permissionRelay).toBe(false)
      expect(result.config.pollMs).toBe(1000)
    }
  })

  test("delegations opt-in via env or file", () => {
    const fromEnv = loadConfig(
      { ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x", THREA_DELEGATIONS: "1" } },
      IDENTITY
    )
    if ("config" in fromEnv) expect(fromEnv.config.delegations).toBe(true)

    const fromFile = loadConfig(
      { ...base, env: { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_x" }, file: { delegations: true } },
      IDENTITY
    )
    if ("config" in fromFile) expect(fromFile.config.delegations).toBe(true)
  })

  test("honors explicit instanceId / runtimeSessionId overrides", () => {
    const result = loadConfig(
      {
        ...base,
        env: {
          THREA_WORKSPACE_ID: "ws_1",
          THREA_API_KEY: "threa_bk_x",
          THREA_INSTANCE_ID: "my.instance",
          THREA_RUNTIME_SESSION_ID: "my.session",
        },
      },
      IDENTITY
    )
    if ("config" in result) {
      expect(result.config.instanceId).toBe("my-instance")
      expect(result.config.runtimeSessionId).toBe("my-session")
    }
  })
})
