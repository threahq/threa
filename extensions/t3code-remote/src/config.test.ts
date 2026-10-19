import { describe, expect, test } from "bun:test"
import { DEFAULT_T3_URL, loadT3Config, loadT3Settings, t3Install } from "./config"

const BASE_ENV = { THREA_WORKSPACE_ID: "ws_1", THREA_API_KEY: "threa_bk_test" }
const INSTALL = t3Install("/home/u")

describe("loadT3Settings", () => {
  test("defaults to the local T3 server at full access, without auto-login", () => {
    expect(loadT3Settings({})).toEqual({ settings: { url: DEFAULT_T3_URL, access: "full-access", autoLogin: false } })
  })

  test("env wins over the file, and a blank env value falls through to it", () => {
    const file = { t3Url: "http://from-file:1/", t3ProjectId: "project_file", t3Access: "auto", t3AutoLogin: true }
    expect([
      loadT3Settings(
        {
          T3CODE_URL: "http://127.0.0.1:20800/",
          T3CODE_PROJECT_ID: "project_env",
          T3CODE_ACCESS: "auto-accept-edits",
          T3CODE_AUTO_LOGIN: "0",
        },
        file
      ),
      loadT3Settings({ T3CODE_URL: " ", T3CODE_ACCESS: "", T3CODE_AUTO_LOGIN: " " }, file),
    ]).toEqual([
      {
        settings: {
          url: "http://127.0.0.1:20800",
          projectId: "project_env",
          access: "auto-accept-edits",
          autoLogin: false,
        },
      },
      { settings: { url: "http://from-file:1", projectId: "project_file", access: "auto", autoLogin: true } },
    ])
  })

  test("T3CODE_AUTO_LOGIN=1 turns auto-login on", () => {
    expect(loadT3Settings({ T3CODE_AUTO_LOGIN: "1" })).toEqual({
      settings: { url: DEFAULT_T3_URL, access: "full-access", autoLogin: true },
    })
  })

  test("rejects an auto-login value that is neither yes nor no", () => {
    expect([loadT3Settings({ T3CODE_AUTO_LOGIN: "ture" }), loadT3Settings({}, { t3AutoLogin: 1 })]).toEqual([
      { error: "Invalid t3AutoLogin: expected true or false." },
      { error: "Invalid t3AutoLogin: expected true or false." },
    ])
  })

  test("rejects an unknown access mode", () => {
    expect(loadT3Settings({}, { t3Access: "yolo" })).toEqual({
      error: "Invalid t3Access: expected one of approval-required, auto-accept-edits, auto, full-access.",
    })
  })
})

describe("loadT3Config", () => {
  test("adds the T3 block and runs turns from the work dir", () => {
    const result = loadT3Config({ env: BASE_ENV, cwd: "/home/dev/project", hostname: "box", install: INSTALL })
    if ("error" in result) throw new Error(result.error)
    expect({
      t3: result.config.t3,
      localCwd: result.config.localCwd,
      instance: result.config.instanceId.startsWith("t3-"),
      displayName: result.config.displayName,
    }).toEqual({
      t3: { url: DEFAULT_T3_URL, access: "full-access", autoLogin: false },
      localCwd: "/home/u/.threa/t3code-remote/work",
      instance: true,
      displayName: "T3 Code - project",
    })
  })
})
