import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runConnect, readStoredConfig, defaultConfigPath } from "./connect"
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
      { error: "authorization_pending" },
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
    // slow_down pushes the interval out by 5s for the rest of the session.
    expect(slept).toEqual([3000, 3000, 8000, 8000])
    expect(calls[0]).toBe("POST https://app.example/api/oauth/device_authorization")
    expect(bodies[0]).toContain("client_id=threa-bot")
    expect(calls.filter((c) => c.endsWith("/api/oauth/token"))).toHaveLength(4)
    expect(bodies[1]).toBe(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=device-secret-1234567890abcdefghijklmnopqrstuv&client_id=threa-bot"
    )
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
