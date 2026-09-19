import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_HERMES_API_URL, hermesInstall, loadHermesConfig, writeCliConfig } from "./config"

const BASE_ENV = { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_test" }
const INSTALL = hermesInstall({ homeDir: "/home/u" })

function load(env: Record<string, string | undefined>, file?: Record<string, unknown>, profile?: string) {
  const install = profile === undefined ? INSTALL : hermesInstall({ homeDir: "/home/u", profile })
  return loadHermesConfig({ env, cwd: "/home/dev/project", hostname: "box", install, ...(file ? { file } : {}) })
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
      localCwd: INSTALL.workDir,
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
  test("hands the CLI this install's identity and key settings at 0600, replacing an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "hermes-cli-config-"))
    const path = join(dir, "nested", "threa-cli.json")
    try {
      writeCliConfig(path, {
        apiKey: "threa_bk_1",
        workspaceId: "ws_1",
        baseUrl: "https://app.threa.io",
        keyScope: "host",
        instanceId: "inst_1",
      })
      writeFileSync(path, "stale")
      writeCliConfig(path, {
        apiKey: "threa_bk_2",
        workspaceId: "ws_2",
        baseUrl: "https://eu.threa.io",
        keyScope: "instance",
        keyStore: "file",
        keyDir: "/keys",
        instanceId: "inst_2",
      })

      expect({
        content: JSON.parse(readFileSync(path, "utf8")) as unknown,
        mode: statSync(path).mode & 0o777,
      }).toEqual({
        content: {
          apiKey: "threa_bk_2",
          workspaceId: "ws_2",
          baseUrl: "https://eu.threa.io",
          keyScope: "instance",
          keyStore: "file",
          keyDir: "/keys",
          instanceId: "inst_2",
          principal: "bot",
        },
        mode: 0o600,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("hermesInstall", () => {
  test("the default install keeps the paths it has always used", () => {
    expect(hermesInstall({ homeDir: "/home/u" })).toEqual({
      serviceName: "threa-hermes-remote.service",
      unitPath: "/home/u/.config/systemd/user/threa-hermes-remote.service",
      envFile: "/home/u/.config/threa/hermes-remote.env",
      configDir: "/home/u/.threa/hermes-remote",
      configPath: "/home/u/.threa/hermes-remote/config.json",
      workDir: "/home/u/.threa/hermes-remote/work",
      logDir: "/home/u/.threa/hermes-remote/log",
      cliConfigPath: "/home/u/.threa/hermes-remote/threa-cli.json",
      hermesHome: "/home/u/.hermes",
      hermesApiUrl: DEFAULT_HERMES_API_URL,
      identity: {
        idPrefix: "hm",
        sessionIdPrefix: "hms",
        displayNamePrefix: "Hermes",
        configPathHint: "/home/u/.threa/hermes-remote/config.json",
      },
    })
  })

  test("a named profile shares no path, no identity prefix and no gateway with the default one", () => {
    const defaults = hermesInstall({ homeDir: "/home/u" })
    const muse = hermesInstall({ homeDir: "/home/u", profile: "muse" })

    expect({
      muse,
      sharedPaths: [muse.unitPath, muse.envFile, muse.configDir, muse.hermesHome].filter((path) =>
        [defaults.unitPath, defaults.envFile, defaults.configDir, defaults.hermesHome].includes(path)
      ),
    }).toEqual({
      muse: {
        profile: "muse",
        serviceName: "threa-hermes-muse.service",
        unitPath: "/home/u/.config/systemd/user/threa-hermes-muse.service",
        envFile: "/home/u/.config/threa/hermes-muse.env",
        configDir: "/home/u/.threa/hermes-muse",
        configPath: "/home/u/.threa/hermes-muse/config.json",
        workDir: "/home/u/.threa/hermes-muse/work",
        logDir: "/home/u/.threa/hermes-muse/log",
        cliConfigPath: "/home/u/.threa/hermes-muse/threa-cli.json",
        hermesHome: "/home/u/.hermes/profiles/muse",
        hermesApiUrl: `${DEFAULT_HERMES_API_URL}/p/muse`,
        identity: {
          idPrefix: "hm-muse",
          sessionIdPrefix: "hms-muse",
          displayNamePrefix: "Hermes muse",
          configPathHint: "/home/u/.threa/hermes-muse/config.json",
        },
        bikPath: "/home/u/.threa/hermes-muse/bik.json",
      },
      sharedPaths: [],
    })
  })

  test("a name Hermes would not accept as a profile is refused", () => {
    expect(() => hermesInstall({ homeDir: "/home/u", profile: "../evil" })).toThrow("Invalid Hermes profile name")
  })
})

describe("loadHermesConfig per profile", () => {
  test("two profiles on one box derive different instance ids from the same directory", () => {
    const one = load({ ...BASE_ENV, HERMES_API_KEY: "k" }, undefined, "muse")
    const two = load({ ...BASE_ENV, HERMES_API_KEY: "k" }, undefined, "scribe")
    if ("error" in one || "error" in two) throw new Error("expected both to load")

    expect({
      muse: one.config.instanceId.startsWith("hm-muse-"),
      scribe: two.config.instanceId.startsWith("hm-scribe-"),
      distinct: one.config.instanceId !== two.config.instanceId,
      bik: one.config.bikPath,
      gateway: one.config.hermes.apiUrl,
      work: one.config.localCwd,
    }).toEqual({
      muse: true,
      scribe: true,
      distinct: true,
      bik: "/home/u/.threa/hermes-muse/bik.json",
      gateway: `${DEFAULT_HERMES_API_URL}/p/muse`,
      work: "/home/u/.threa/hermes-muse/work",
    })
  })

  test("the default install keeps the pre-keyring BIK file, and an explicit one always wins", () => {
    const defaults = load({ ...BASE_ENV, HERMES_API_KEY: "k" })
    const overridden = load({ ...BASE_ENV, HERMES_API_KEY: "k", THREA_BIK_PATH: "/keys/bik.json" }, undefined, "muse")
    if ("error" in defaults || "error" in overridden) throw new Error("expected both to load")

    expect([defaults.config.bikPath, overridden.config.bikPath]).toEqual([undefined, "/keys/bik.json"])
  })
})
