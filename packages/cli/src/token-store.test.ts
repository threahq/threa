import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TokenStore } from "./token-store"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "threa-token-store-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test("set persists a token that a fresh store instance loads back", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")

  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_a")
})

test("get returns undefined for an unknown workspace or delegation, and when no file exists", () => {
  const store = new TokenStore(join(dir, "missing.json"))
  expect(store.get("ws_1", "dlg_1")).toBeUndefined()

  store.set("ws_1", "dlg_1", "tok_a")
  expect(store.get("ws_2", "dlg_1")).toBeUndefined()
  expect(store.get("ws_1", "dlg_2")).toBeUndefined()
})

test("delete clears one token and prunes an emptied workspace, leaving siblings intact", () => {
  const path = join(dir, "state.json")
  const store = new TokenStore(path)
  store.set("ws_1", "dlg_1", "tok_a")
  store.set("ws_1", "dlg_2", "tok_b")
  store.set("ws_2", "dlg_9", "tok_c")

  store.delete("ws_1", "dlg_1")
  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBeUndefined()
  expect(new TokenStore(path).get("ws_1", "dlg_2")).toBe("tok_b")

  store.delete("ws_1", "dlg_2")
  const state = JSON.parse(readFileSync(path, "utf8")) as { claimTokens: Record<string, unknown> }
  expect(state.claimTokens.ws_1).toBeUndefined()
  expect(state.claimTokens.ws_2).toEqual({ dlg_9: "tok_c" })
})

test("a later set overwrites the token for the same key", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_b")

  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_b")
})

test("a corrupt state file warns once on stderr and starts empty rather than throwing", () => {
  const path = join(dir, "state.json")
  writeFileSync(path, "{ not json")
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    const store = new TokenStore(path)
    expect(store.get("ws_1", "dlg_1")).toBeUndefined()
    expect(store.get("ws_1", "dlg_2")).toBeUndefined()
    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes("corrupt"))
    expect(warnings.length).toBe(1)
  } finally {
    warn.mockRestore()
  }
})

test("a missing file loads silently with no stderr warning", () => {
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    new TokenStore(join(dir, "nope.json")).get("ws_1", "dlg_1")
    expect(warn.mock.calls.length).toBe(0)
  } finally {
    warn.mockRestore()
  }
})

test("the persisted file is written with 0600 permissions", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")

  expect(existsSync(path)).toBe(true)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("THREA_STATE_FILE overrides the default path when no constructor arg is given", () => {
  const path = join(dir, "env-state.json")
  const prev = process.env.THREA_STATE_FILE
  process.env.THREA_STATE_FILE = path
  try {
    new TokenStore().set("ws_1", "dlg_1", "tok_env")
    expect(existsSync(path)).toBe(true)
    expect(new TokenStore().get("ws_1", "dlg_1")).toBe("tok_env")
  } finally {
    if (prev === undefined) delete process.env.THREA_STATE_FILE
    else process.env.THREA_STATE_FILE = prev
  }
})
