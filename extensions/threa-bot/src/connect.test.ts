import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runConnect, readStoredConfig, defaultConfigPath } from "./connect"
import { resolveConfig } from "./run"

function fakeThrea(pollResults: Array<Record<string, unknown>>) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${url}`)
    if (url.endsWith("/api/bot-connect")) {
      return Response.json(
        {
          deviceCode: "device-secret-1234567890abcdefghijklmnopqrstuv",
          userCode: "BCDF-GHJK",
          verificationUrl: "https://app.example/connect?code=BCDF-GHJK",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          intervalSeconds: 3,
        },
        { status: 201 }
      )
    }
    if (url.includes("/api/bot-connect/poll?deviceCode=device-secret")) {
      return Response.json(pollResults.shift() ?? { status: "pending" })
    }
    return new Response("not found", { status: 404 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("threa-bot connect", () => {
  test("polls until approved, stores the key with owner-only permissions, and run picks it up", async () => {
    const home = mkdtempSync(join(tmpdir(), "threa-bot-home-"))
    const configPath = defaultConfigPath({ HOME: home })
    const approved = {
      status: "approved",
      baseUrl: "https://app.example",
      workspaceId: "ws_1",
      workspaceName: "Acme",
      botId: "bot_1",
      botSlug: "my-agent",
      apiKey: "threa_bk_secret",
    }
    const { fetchImpl, calls } = fakeThrea([{ status: "pending" }, { status: "pending" }, approved])
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
    expect(slept).toEqual([3000, 3000, 3000])
    expect(calls[0]).toBe("POST https://app.example/api/bot-connect")
    expect(calls.filter((c) => c.includes("/poll"))).toHaveLength(3)
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
    const { fetchImpl } = fakeThrea([{ status: "denied" }])
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
