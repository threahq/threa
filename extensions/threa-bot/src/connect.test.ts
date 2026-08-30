import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSecureBaseUrl, runConnect, readStoredConfig, defaultConfigPath } from "./connect"
import { chmodSync, writeFileSync } from "node:fs"
import { resolveConfig } from "./run"

function fakeThrea(tokenResults: Array<Record<string, unknown>>) {
  const calls: string[] = []
  const bodies: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${url}`)
    bodies.push(String(init?.body ?? ""))
    if (url.endsWith("/api/oauth/device_authorization")) {
      return Response.json({
        device_code: "device-secret-1234567890abcdefghijklmnopqrstuv",
        user_code: "BCDF-GHJK",
        verification_uri: "https://app.example/connect",
        verification_uri_complete: "https://app.example/connect?code=BCDF-GHJK",
        expires_in: 60,
        interval: 3,
      })
    }
    if (url.endsWith("/api/oauth/token")) {
      const next = tokenResults.shift() ?? { error: "authorization_pending" }
      if (next.rateLimited) return new Response("Too Many Requests", { status: 429 })
      if (next.networkError) throw new TypeError("fetch failed")
      if (next.serverError) return new Response("bad gateway", { status: 502 })
      return Response.json(next, { status: "error" in next ? 400 : 200 })
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls, bodies }
}

describe("threa-bot connect", () => {
  test("polls until approved, stores the key with owner-only permissions, and run picks it up", async () => {
    const home = mkdtempSync(join(tmpdir(), "threa-bot-home-"))
    const configPath = defaultConfigPath({ HOME: home })
    const issued = {
      access_token: "threa_bk_secret",
      token_type: "Bearer",
      scope: "bot-runtime:write",
      base_url: "https://app.example",
      workspace_id: "ws_1",
      workspace_name: "Acme",
      bot_id: "bot_1",
      bot_slug: "my-agent",
    }
    const { fetchImpl, calls, bodies } = fakeThrea([
      { error: "authorization_pending" },
      { error: "slow_down" },
      { rateLimited: true },
      { networkError: true },
      { serverError: true },
      issued,
    ])
    const printed: string[] = []
    const slept: number[] = []
    const stored = await runConnect(
      { baseUrl: "https://app.example/", name: "my-agent" },
      {
        fetch: fetchImpl,
        log: () => undefined,
        print: (line) => printed.push(line),
        sleep: async (ms) => void slept.push(ms),
        configPath,
        env: {},
      }
    )
    expect(stored).toEqual({
      baseUrl: "https://app.example",
      workspaceId: "ws_1",
      workspaceName: "Acme",
      botId: "bot_1",
      botSlug: "my-agent",
      apiKey: "threa_bk_secret",
    })
    expect(printed[0]).toBe("Open https://app.example/connect?code=BCDF-GHJK")
    expect(printed[1]).toContain("BCDF-GHJK")
    // slow_down, an edge 429, a dropped connection and a 5xx all push the interval out by 5s.
    expect(slept).toEqual([3000, 3000, 8000, 13000, 18000, 23000])
    // The whole request sequence, in order: one authorization, then one identical token poll per sleep.
    const tokenBody =
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=device-secret-1234567890abcdefghijklmnopqrstuv&client_id=threa-bot"
    expect(calls.map((call, i) => ({ call, body: bodies[i] }))).toEqual([
      {
        call: "POST https://app.example/api/oauth/device_authorization",
        body: expect.stringMatching(/^client_id=threa-bot&name=my-agent&host=[^&]+$/),
      },
      ...Array.from({ length: 6 }, () => ({ call: "POST https://app.example/api/oauth/token", body: tokenBody })),
    ])
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(stored)
    expect(readStoredConfig(configPath)).toEqual(stored)

    const config = resolveConfig(
      { kind: "run", command: ["my-agent"], mode: "scratchpad" },
      { env: { HOME: home }, cwd: "/tmp/project", log: () => undefined }
    )
    expect(config).toMatchObject({ baseUrl: "https://app.example", workspaceId: "ws_1", apiKey: "threa_bk_secret" })
  })

  test("a denied request fails with a message that says what to do", async () => {
    const { fetchImpl } = fakeThrea([{ error: "access_denied" }])
    await expect(
      runConnect(
        {},
        {
          fetch: fetchImpl,
          log: () => undefined,
          print: () => undefined,
          sleep: async () => undefined,
          configPath: join(mkdtempSync(join(tmpdir(), "threa-bot-home-")), "bot.json"),
          env: { THREA_BASE_URL: "https://app.example" },
        }
      )
    ).rejects.toThrow("denied")
  })

  test("refuses a plaintext origin unless it is loopback", () => {
    expect(assertSecureBaseUrl("https://app.threa.io/")).toBe("https://app.threa.io")
    expect(assertSecureBaseUrl("http://localhost:3000")).toBe("http://localhost:3000")
    expect(assertSecureBaseUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000")
    expect(() => assertSecureBaseUrl("http://threa.example")).toThrow("must use https")
    expect(() => assertSecureBaseUrl("app.threa.io")).toThrow("Not a URL")
  })

  test("a rate-limited authorization is a clear error, and an existing world-readable config ends up 0600", async () => {
    const home = mkdtempSync(join(tmpdir(), "threa-bot-home-"))
    const configPath = defaultConfigPath({ HOME: home })
    const limited = (async () => new Response("Too Many Requests", { status: 429 })) as unknown as typeof fetch
    await expect(
      runConnect(
        { baseUrl: "https://app.example" },
        {
          fetch: limited,
          log: () => undefined,
          print: () => undefined,
          sleep: async () => undefined,
          configPath,
          env: {},
        }
      )
    ).rejects.toThrow("rate limiting")

    mkdirSync(join(home, ".threa"), { recursive: true })
    writeFileSync(configPath, "{}", { mode: 0o644 })
    chmodSync(configPath, 0o644)
    const { fetchImpl } = fakeThrea([
      {
        access_token: "threa_bk_new",
        token_type: "Bearer",
        scope: "",
        base_url: "https://app.example",
        workspace_id: "ws_2",
        workspace_name: "Two",
        bot_id: "bot_2",
        bot_slug: "two",
      },
    ])
    await runConnect(
      { baseUrl: "https://app.example" },
      {
        fetch: fetchImpl,
        log: () => undefined,
        print: () => undefined,
        sleep: async () => undefined,
        configPath,
        env: {},
      }
    )
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(readStoredConfig(configPath)?.apiKey).toBe("threa_bk_new")
  })

  test("a damaged stored config is ignored when the environment carries credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "threa-bot-home-"))
    mkdirSync(join(home, ".threa"), { recursive: true })
    writeFileSync(join(home, ".threa", "bot.json"), "{ not json")
    const logs: string[] = []
    const config = resolveConfig(
      { kind: "run", command: ["x"], mode: "scratchpad" },
      {
        env: { HOME: home, THREA_WORKSPACE_ID: "ws_env", THREA_API_KEY: "threa_bk_env" },
        cwd: "/p",
        log: (l) => logs.push(l),
      }
    )
    expect(config.workspaceId).toBe("ws_env")
    expect(logs).toEqual([])
    expect(() =>
      resolveConfig(
        { kind: "run", command: ["x"], mode: "scratchpad" },
        { env: { HOME: home }, cwd: "/p", log: (l) => logs.push(l) }
      )
    ).toThrow("threa-bot connect")
    expect(logs[0]).toContain("ignoring")
  })

  test("run without credentials or a stored config points at connect", () => {
    const home = mkdtempSync(join(tmpdir(), "threa-bot-home-"))
    expect(() =>
      resolveConfig(
        { kind: "run", command: ["x"], mode: "scratchpad" },
        { env: { HOME: home }, cwd: "/p", log: () => undefined }
      )
    ).toThrow("threa-bot connect")
  })
})
