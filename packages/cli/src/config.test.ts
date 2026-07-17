import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config"

const ENV_KEYS = ["THREA_API_KEY", "THREA_WORKSPACE_ID", "THREA_BASE_URL", "THREA_CONFIG", "HOME"] as const

let saved: Record<string, string | undefined>
let home: string

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  home = mkdtempSync(join(tmpdir(), "threa-cli-home-"))
  process.env.HOME = home
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(home, { recursive: true, force: true })
})

function writeConfigFile(config: Record<string, unknown>, filename = "config.json"): string {
  mkdirSync(join(home, ".threa"), { recursive: true })
  const path = join(home, ".threa", filename)
  writeFileSync(path, JSON.stringify(config))
  return path
}

test("env vars supply config and baseUrl defaults", () => {
  process.env.THREA_API_KEY = "threa_uk_env"
  process.env.THREA_WORKSPACE_ID = "ws_env"
  expect(loadConfig()).toEqual({
    apiKey: "threa_uk_env",
    workspaceId: "ws_env",
    baseUrl: "https://app.threa.io",
    output: "text",
  })
})

test("missing required vars fail loudly and name each one", () => {
  expect(() => loadConfig()).toThrow(/THREA_API_KEY/)
  expect(() => loadConfig()).toThrow(/THREA_WORKSPACE_ID/)
})

test("config file at ~/.threa/config.json supplies values when env is absent", () => {
  writeConfigFile({
    apiKey: "threa_uk_file",
    workspaceId: "ws_file",
    baseUrl: "https://staging.threa.io",
  })
  expect(loadConfig()).toEqual({
    apiKey: "threa_uk_file",
    workspaceId: "ws_file",
    baseUrl: "https://staging.threa.io",
    output: "text",
  })
})

test("legacy ~/.threa/mcp.json is still read when config.json is absent", () => {
  writeConfigFile({ apiKey: "threa_uk_legacy", workspaceId: "ws_legacy" }, "mcp.json")
  expect(loadConfig()).toEqual({
    apiKey: "threa_uk_legacy",
    workspaceId: "ws_legacy",
    baseUrl: "https://app.threa.io",
    output: "text",
  })
})

test("config.json wins over a lingering mcp.json", () => {
  writeConfigFile({ apiKey: "threa_uk_old", workspaceId: "ws_old" }, "mcp.json")
  writeConfigFile({ apiKey: "threa_uk_new", workspaceId: "ws_new" })
  const config = loadConfig()
  expect(config.apiKey).toBe("threa_uk_new")
  expect(config.workspaceId).toBe("ws_new")
})

test("config file sets the default output mode", () => {
  writeConfigFile({ apiKey: "threa_uk_file", workspaceId: "ws_file", output: "json" })
  expect(loadConfig().output).toBe("json")
})

test("an invalid output mode in the config fails loudly", () => {
  writeConfigFile({ apiKey: "threa_uk_file", workspaceId: "ws_file", output: "yaml" })
  expect(() => loadConfig()).toThrow(/output.*must be one of/i)
})

test("env wins over file per key", () => {
  writeConfigFile({
    apiKey: "threa_uk_file",
    workspaceId: "ws_file",
    baseUrl: "https://staging.threa.io",
  })
  process.env.THREA_WORKSPACE_ID = "ws_env"
  const config = loadConfig()
  expect(config.workspaceId).toBe("ws_env")
  expect(config.apiKey).toBe("threa_uk_file")
  expect(config.baseUrl).toBe("https://staging.threa.io")
})

test("THREA_CONFIG points at an explicit file", () => {
  const dir = mkdtempSync(join(tmpdir(), "threa-cli-cfg-"))
  const path = join(dir, "custom.json")
  writeFileSync(path, JSON.stringify({ apiKey: "threa_uk_custom", workspaceId: "ws_custom" }))
  process.env.THREA_CONFIG = path
  try {
    expect(loadConfig()).toEqual({
      apiKey: "threa_uk_custom",
      workspaceId: "ws_custom",
      baseUrl: "https://app.threa.io",
      output: "text",
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("explicit THREA_CONFIG that cannot be read fails loudly", () => {
  process.env.THREA_CONFIG = join(home, "does-not-exist.json")
  expect(() => loadConfig()).toThrow(/THREA_CONFIG/)
})

test("loadConfig rejects a non-https base URL", () => {
  process.env.THREA_API_KEY = "threa_uk_x"
  process.env.THREA_WORKSPACE_ID = "ws_x"
  process.env.THREA_BASE_URL = "http://attacker.example"
  expect(() => loadConfig()).toThrow(/must be https/)
})

test("loadConfig allows http for localhost", () => {
  process.env.THREA_API_KEY = "threa_uk_x"
  process.env.THREA_WORKSPACE_ID = "ws_x"
  process.env.THREA_BASE_URL = "http://localhost:4471"
  expect(loadConfig().baseUrl).toBe("http://localhost:4471")
})
