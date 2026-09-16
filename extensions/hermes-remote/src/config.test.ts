import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_HERMES_API_URL, loadHermesConfig, WORK_DIR, writeCliConfig } from "./config"

const BASE_ENV = { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_test" }

function load(env: Record<string, string | undefined>, file?: Record<string, unknown>) {
  return loadHermesConfig({ env, cwd: "/home/dev/project", hostname: "box", ...(file ? { file } : {}) })
}

describe("loadHermesConfig", () => {
  test("resolves the Hermes block and the work dir", () => {
    const result = load({ ...BASE_ENV, HERMES_API_KEY: "hermes-key" })
    expect("error" in result).toBe(false)
    if ("error" in result) return
    expect({
      hermes: result.config.hermes,
      localCwd: result.config.localCwd,
      instance: result.config.instanceId.startsWith("hm-"),
      runtimeSession: result.config.runtimeSessionId.startsWith("hms-"),
      displayName: result.config.displayName,
    }).toEqual({
      hermes: { apiUrl: DEFAULT_HERMES_API_URL, apiKey: "hermes-key" },
      localCwd: WORK_DIR,
      instance: true,
      runtimeSession: true,
      displayName: "Hermes - project",
    })
  })

  test("fails naming HERMES_API_KEY when neither env nor file carries one", () => {
    const result = load({ ...BASE_ENV })
    expect("error" in result && result.error).toContain("HERMES_API_KEY")
  })

  test("env wins over the file, and a blank env value falls through to it", () => {
    const envWins = load(
      { ...BASE_ENV, HERMES_API_KEY: "from-env", HERMES_API_URL: "http://127.0.0.1:9000/" },
      { hermesApiKey: "from-file", hermesApiUrl: "http://from-file:1/" }
    )
    const blankFallsThrough = load(
      { ...BASE_ENV, HERMES_API_KEY: "   ", HERMES_API_URL: "" },
      { hermesApiKey: "from-file", hermesApiUrl: "http://from-file:1/" }
    )

    expect([
      "error" in envWins ? envWins.error : envWins.config.hermes,
      "error" in blankFallsThrough ? blankFallsThrough.error : blankFallsThrough.config.hermes,
    ]).toEqual([
      { apiUrl: "http://127.0.0.1:9000", apiKey: "from-env" },
      { apiUrl: "http://from-file:1", apiKey: "from-file" },
    ])
  })
})

describe("writeCliConfig", () => {
  test("writes the four CLI fields at 0600 and replaces an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-cli-config-"))
    const path = join(dir, "nested", "threa-cli.json")
    try {
      writeCliConfig(path, { apiKey: "threa_bk_1", workspaceId: "ws_1", baseUrl: "https://app.threa.io" })
      writeFileSync(path, "stale")
      writeCliConfig(path, { apiKey: "threa_bk_2", workspaceId: "ws_2", baseUrl: "https://eu.threa.io" })

      expect({
        content: JSON.parse(readFileSync(path, "utf8")) as unknown,
        mode: statSync(path).mode & 0o777,
      }).toEqual({
        content: {
          apiKey: "threa_bk_2",
          workspaceId: "ws_2",
          baseUrl: "https://eu.threa.io",
          principal: "bot",
        },
        mode: 0o600,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
