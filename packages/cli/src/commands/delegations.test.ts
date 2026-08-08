import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "../cli"
import { jsonResponse, TEST_CONFIG } from "../test-support"
import { TokenStore } from "../token-store"

const fetchSpy = spyOn(globalThis, "fetch")

let dir: string
let statePath: string
let prevStateFile: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "threa-delegations-"))
  statePath = join(dir, "state.json")
  prevStateFile = process.env.THREA_STATE_FILE
  process.env.THREA_STATE_FILE = statePath
})

afterEach(() => {
  fetchSpy.mockReset()
  if (prevStateFile === undefined) delete process.env.THREA_STATE_FILE
  else process.env.THREA_STATE_FILE = prevStateFile
  rmSync(dir, { recursive: true, force: true })
})

function pathOf(index: number): string {
  return new URL(String(fetchSpy.mock.calls[index]![0])).pathname
}

function callbackHeader(index: number): string | undefined {
  const headers = (fetchSpy.mock.calls[index]![1] as RequestInit).headers as Record<string, string> | undefined
  return headers?.["X-Threa-Callback-Token"]
}

function bodyOf(index: number): Record<string, unknown> {
  return JSON.parse(String((fetchSpy.mock.calls[index]![1] as RequestInit).body)) as Record<string, unknown>
}

test("delegation help documents inspect, availability polling, manual heartbeat, and successful token clearing", async () => {
  const noun = await run(["delegations", "--help"], { config: TEST_CONFIG })
  const list = await run(["delegations", "list", "--help"], { config: TEST_CONFIG })
  const update = await run(["delegations", "update", "--help"], { config: TEST_CONFIG })
  const release = await run(["delegations", "release", "--help"], { config: TEST_CONFIG })

  expect(noun.stdout).toContain("get")
  expect(noun.stdout).toContain("release")
  expect(list.stdout).toContain("availability changed after")
  expect(update.stdout).toContain("pure heartbeat")
  expect(release.stdout).toContain("only a matching stored token is cleared")
  expect(release.stdout).toContain("replacement token is preserved")
})

test("get inspects the full delegation without writing token state", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", brief: "do it", contextRefs: ["msg_1"] } }))
  const result = await run(["delegations", "get", "dlg_1", "--json"], { config: TEST_CONFIG })
  expect(result.exitCode).toBe(0)
  expect(pathOf(0)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1")
  expect(JSON.parse(result.stdout)).toEqual({ data: { id: "dlg_1", brief: "do it", contextRefs: ["msg_1"] } })
  expect(existsSync(statePath)).toBe(false)
})

test("release uses stored token and clears it only after success", async () => {
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  await run(["delegations", "claim", "dlg_1", "--label", "runner"], { config: TEST_CONFIG })
  fetchSpy.mockResolvedValueOnce(jsonResponse(500, { code: "INTERNAL" }))
  expect((await run(["delegations", "release", "dlg_1"], { config: TEST_CONFIG })).exitCode).toBe(1)
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", status: "open" } }))
  expect(
    (await run(["delegations", "release", "dlg_1", "--claim-token", "tok_explicit"], { config: TEST_CONFIG })).exitCode
  ).toBe(0)
  expect(callbackHeader(1)).toBe("tok_stored")
  expect(callbackHeader(2)).toBe("tok_explicit")
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { claimTokens: Record<string, unknown> }
  expect(state.claimTokens.ws_1).toEqual({ dlg_1: "tok_stored" })
})

test("a delayed release response does not delete a replacement claim token", async () => {
  const store = new TokenStore(statePath)
  store.set("ws_1", "dlg_1", "tok_old")
  let resolveResponse!: (response: Response) => void
  fetchSpy.mockImplementationOnce(
    (() => new Promise<Response>((resolve) => (resolveResponse = resolve))) as unknown as typeof fetch
  )

  const releasing = run(["delegations", "release", "dlg_1"], { config: TEST_CONFIG, tokenStore: store })
  while (fetchSpy.mock.calls.length === 0) await Promise.resolve()
  new TokenStore(statePath).set("ws_1", "dlg_1", "tok_new")
  resolveResponse(jsonResponse(200, { data: { id: "dlg_1", status: "open" } }))

  expect((await releasing).exitCode).toBe(0)
  expect(new TokenStore(statePath).get("ws_1", "dlg_1")).toBe("tok_new")
})

test("a delayed explicit-token release does not delete another store's replacement token", async () => {
  new TokenStore(statePath).set("ws_1", "dlg_1", "tok_stored")
  let resolveResponse!: (response: Response) => void
  fetchSpy.mockImplementationOnce(
    (() => new Promise<Response>((resolve) => (resolveResponse = resolve))) as unknown as typeof fetch
  )

  const releasing = run(["delegations", "release", "dlg_1", "--claim-token", "tok_explicit_old"], {
    config: TEST_CONFIG,
    tokenStore: new TokenStore(statePath),
  })
  while (fetchSpy.mock.calls.length === 0) await Promise.resolve()
  new TokenStore(statePath).set("ws_1", "dlg_1", "tok_new")
  resolveResponse(jsonResponse(200, { data: { id: "dlg_1", status: "open" } }))

  expect((await releasing).exitCode).toBe(0)
  expect(new TokenStore(statePath).get("ws_1", "dlg_1")).toBe("tok_new")
})

test("a loaded shared-head store resolves a token written by another process for lifecycle calls", async () => {
  const sharedHead = new TokenStore(statePath)
  expect(sharedHead.get("ws_1", "dlg_1")).toBeUndefined()
  new TokenStore(statePath).set("ws_1", "dlg_1", "tok_shared")
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", status: "running" } }))

  const result = await run(["delegations", "update", "dlg_1", "--note", "working"], {
    config: TEST_CONFIG,
    tokenStore: sharedHead,
  })

  expect(result.exitCode).toBe(0)
  expect(callbackHeader(0)).toBe("tok_shared")
})

test("release without a token fails before HTTP", async () => {
  const result = await run(["delegations", "release", "dlg_1"], { config: TEST_CONFIG })
  expect(result.exitCode).toBe(1)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("claim persists the token to the state file and prints it in the result", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { id: "dlg_1", brief: "do it", claimToken: "tok_secret" } }))

  const result = await run(
    ["delegations", "claim", "dlg_1", "--label", "Kris's MacBook", "--idempotency-key", "idem-key-12345", "--json"],
    {
      config: TEST_CONFIG,
    }
  )

  expect(result.exitCode).toBe(0)
  expect(pathOf(0)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/claim")
  expect(bodyOf(0)).toEqual({ claimedByLabel: "Kris's MacBook", idempotencyKey: "idem-key-12345" })
  expect((JSON.parse(result.stdout) as { data: { claimToken: string } }).data.claimToken).toBe("tok_secret")

  const state = JSON.parse(readFileSync(statePath, "utf8")) as { claimTokens: { ws_1: { dlg_1: string } } }
  expect(state.claimTokens.ws_1.dlg_1).toBe("tok_secret")
})

test("claim then update reuses the stored token across separate invocations, then finish clears it", async () => {
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  await run(["delegations", "claim", "dlg_1", "--label", "runner"], { config: TEST_CONFIG })

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1" } }))
  const updated = await run(["delegations", "update", "dlg_1", "--note", "halfway"], {
    config: TEST_CONFIG,
  })
  expect(updated.exitCode).toBe(0)
  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/status")
  expect(bodyOf(1)).toEqual({ statusNote: "halfway" })
  expect(callbackHeader(1)).toBe("tok_stored")

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", status: "completed" } }))
  const finished = await run(["delegations", "finish", "dlg_1", "--outcome", "complete", "--result", "shipped"], {
    config: TEST_CONFIG,
  })
  expect(finished.exitCode).toBe(0)
  expect(pathOf(2)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/complete")
  expect(bodyOf(2)).toEqual({ resultMarkdown: "shipped" })
  expect(callbackHeader(2)).toBe("tok_stored")

  const state = JSON.parse(readFileSync(statePath, "utf8")) as { claimTokens: Record<string, unknown> }
  expect(state.claimTokens.ws_1).toBeUndefined()

  const again = await run(["delegations", "update", "dlg_1", "--note", "again"], { config: TEST_CONFIG })
  expect(again.exitCode).toBe(1)
  expect((JSON.parse(again.stderr) as { code: string }).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy.mock.calls.length).toBe(3)
})

test("update without a note posts a pure heartbeat carrying the stored token", async () => {
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_hb" } }))
  await run(["delegations", "claim", "dlg_1", "--label", "runner"], { config: TEST_CONFIG })

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { claimExpiresAt: "2026-07-16T00:15:00.000Z" } }))
  await run(["delegations", "update", "dlg_1"], { config: TEST_CONFIG })

  expect(pathOf(1)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/heartbeat")
  expect(callbackHeader(1)).toBe("tok_hb")
})

test("finish --outcome fail without --error is a usage error (exit 2) before any HTTP", async () => {
  const result = await run(["delegations", "finish", "dlg_1", "--outcome", "fail"], {
    config: TEST_CONFIG,
  })

  expect(result.exitCode).toBe(2)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("USAGE")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("finish --outcome fail rejects --result and --metadata, naming them, before any HTTP", async () => {
  const result = await run(
    ["delegations", "finish", "dlg_1", "--outcome", "fail", "--error", "broke", "--result", "x", "--metadata", "k=v"],
    { config: TEST_CONFIG }
  )

  expect(result.exitCode).toBe(2)
  const err = JSON.parse(result.stderr) as { code: string; message: string }
  expect(err.code).toBe("USAGE")
  expect(err.message).toContain("result_markdown")
  expect(err.message).toContain("metadata")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("update with no stored or explicit token errors before any HTTP", async () => {
  const result = await run(["delegations", "update", "dlg_unknown"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(1)
  expect((JSON.parse(result.stderr) as { code: string }).code).toBe("MISSING_CLAIM_TOKEN")
  expect(fetchSpy).not.toHaveBeenCalled()
})

test("an explicit --claim-token overrides the stored one", async () => {
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_stored" } }))
  await run(["delegations", "claim", "dlg_1", "--label", "runner"], { config: TEST_CONFIG })

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1" } }))
  await run(["delegations", "update", "dlg_1", "--note", "x", "--claim-token", "tok_explicit"], {
    config: TEST_CONFIG,
  })

  expect(callbackHeader(1)).toBe("tok_explicit")
})

test("delegations list returns the open queue with the since filter", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: [{ id: "dlg_1" }] }))

  const result = await run(["delegations", "list", "--since", "2026-07-16T00:00:00.000Z"], {
    config: TEST_CONFIG,
  })

  expect(result.exitCode).toBe(0)
  const url = new URL(String(fetchSpy.mock.calls[0]![0]))
  expect(url.pathname).toBe("/api/v1/workspaces/ws_1/delegations")
  expect(url.searchParams.get("since")).toBe("2026-07-16T00:00:00.000Z")
})

test("request-access posts to the request-access route", async () => {
  fetchSpy.mockResolvedValue(jsonResponse(200, { data: { already_granted: false } }))

  const result = await run(["delegations", "request-access", "dlg_1"], { config: TEST_CONFIG })

  expect(result.exitCode).toBe(0)
  expect(pathOf(0)).toBe("/api/v1/workspaces/ws_1/delegations/dlg_1/request-access")
})

test("finish --result `-` reads the result markdown from stdin", async () => {
  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", claimToken: "tok_x" } }))
  await run(["delegations", "claim", "dlg_1", "--label", "runner"], { config: TEST_CONFIG })

  fetchSpy.mockResolvedValueOnce(jsonResponse(200, { data: { id: "dlg_1", status: "completed" } }))
  await run(["delegations", "finish", "dlg_1", "--outcome", "complete", "--result", "-"], {
    config: TEST_CONFIG,
    readStdin: () => Promise.resolve("# Report\nDone."),
  })

  expect(bodyOf(1)).toEqual({ resultMarkdown: "# Report\nDone." })
  expect(existsSync(statePath)).toBe(true)
})
