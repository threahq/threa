import { afterEach, describe, expect, test } from "bun:test"
import { fetchScratchpadStatus, preflightRuntimeSession } from "./resume"
import { reviveAgent, runtimeSupervisorTargets, type ReviveDeps } from "./commands"
import type { ManagedAgent, RuntimeKind, ThreaChannelConfig } from "./types"

const WORKSPACE = "ws_test"
const ROOT = "stream_root"
const CLAUDE_KEY = "claude-key"
const PI_KEY = "pi-key"

interface RequestRecord {
  authorization: string | null
  method: string
  path: string
}

let server: ReturnType<typeof Bun.serve> | undefined
const savedEnvironment = {
  THREA_API_KEY: process.env.THREA_API_KEY,
  THREA_BASE_URL: process.env.THREA_BASE_URL,
  THREA_WORKSPACE_ID: process.env.THREA_WORKSPACE_ID,
}

afterEach(() => {
  server?.stop(true)
  server = undefined
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function startRuntimeServer() {
  const requests: RequestRecord[] = []
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      requests.push({ authorization, method: request.method, path: url.pathname })

      if (url.pathname === `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}`) {
        return Response.json({ data: { id: ROOT, archivedAt: null } })
      }
      if (url.pathname === `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions`) {
        const body = (await request.json()) as { runtimeKind?: string }
        const expected = body.runtimeKind === "pi-local" ? `Bearer ${PI_KEY}` : `Bearer ${CLAUDE_KEY}`
        if (authorization !== expected) return new Response("wrong bot", { status: 403 })
        return Response.json({ data: { rootStreamId: ROOT, activeStreamId: ROOT } })
      }
      return new Response("not found", { status: 404 })
    },
  })

  const baseUrl = `http://127.0.0.1:${server.port}`
  const configs: Record<RuntimeKind, ThreaChannelConfig> = {
    claude: { baseUrl, workspaceId: WORKSPACE, apiKey: CLAUDE_KEY },
    pi: { baseUrl, workspaceId: WORKSPACE, apiKey: PI_KEY },
  }
  return { baseUrl, configs, requests }
}

function managedAgent(runtime: RuntimeKind, baseUrl: string): ManagedAgent {
  return {
    id: `${runtime}-child`,
    name: `${runtime}-child`,
    runtime,
    status: "offline",
    worktree: `/repo/${runtime}-child`,
    instanceId: `${runtime}-instance`,
    runtimeSessionId: `${runtime}-session`,
    scratchpadUrl: `${baseUrl}/w/${WORKSPACE}/s/${ROOT}`,
    activeStreamId: "stream_child",
    command: [],
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  }
}

function reviveDeps(runtime: RuntimeKind, configs: Record<RuntimeKind, ThreaChannelConfig>): ReviveDeps {
  return {
    claudeConfig: configs.claude,
    piConfig: configs.pi,
    paneStatus: () => "missing",
    unblockAlivePane: async () => undefined,
    claudeProcessesIn: () => [],
    pathExists: () => true,
    scratchpadStatus: fetchScratchpadStatus,
    preflight: preflightRuntimeSession,
    restoreWorktree: () => ({ restored: false }),
    restorableWorktree: () => ({ repo: "/repo" }),
    piLink: (runtimeSessionId) =>
      runtime === "pi" ? { instanceId: "pi-instance", rootStreamId: ROOT, scratchpadUrl: "unused" } : undefined,
    claudeIdentity: () => ({
      instanceId: "claude-instance",
      runtimeSessionId: "claude-session",
      source: "inventory",
    }),
    resumeRuntime: async (agent) => ({
      worktree: agent.worktree!,
      branch: "feature/test",
      tmuxSession: "test",
      tmuxWindow: agent.name,
      tmuxWindowId: "@1",
      tmuxPaneId: "%1",
      output: "revived",
    }),
    persist: () => {},
    killWindow: () => {},
  }
}

describe("cross-runtime supervisor and revival credentials", () => {
  test("should select each configured bot supervisor instead of replacing both with the ambient parent key", () => {
    const { baseUrl, configs } = startRuntimeServer()
    process.env.THREA_BASE_URL = baseUrl
    process.env.THREA_WORKSPACE_ID = WORKSPACE
    process.env.THREA_API_KEY = "ambient-parent-key"

    expect(runtimeSupervisorTargets(configs.claude, configs.pi)).toEqual([
      { baseUrl, workspaceId: WORKSPACE, apiKey: CLAUDE_KEY },
      { baseUrl, workspaceId: WORKSPACE, apiKey: PI_KEY },
      { baseUrl, workspaceId: WORKSPACE, apiKey: "ambient-parent-key" },
    ])
  })

  test("should retain a single ambient target when no runtime config has a bot identity", () => {
    process.env.THREA_BASE_URL = "http://127.0.0.1:43210"
    process.env.THREA_WORKSPACE_ID = WORKSPACE
    process.env.THREA_API_KEY = "standalone-key"

    expect(runtimeSupervisorTargets({}, {})).toEqual([
      {
        baseUrl: "http://127.0.0.1:43210",
        workspaceId: WORKSPACE,
        apiKey: "standalone-key",
      },
    ])
  })

  test("should reject an incomplete configured bot instead of silently omitting its supervisor", () => {
    delete process.env.THREA_WORKSPACE_ID

    expect(() =>
      runtimeSupervisorTargets(
        { baseUrl: "https://claude.example", workspaceId: WORKSPACE, apiKey: CLAUDE_KEY },
        { baseUrl: "https://pi.example", apiKey: PI_KEY }
      )
    ).toThrow("no runtime-specific Threa credentials found to supervise the configured runtime")
  })

  test("should reject ambiguous ambient credentials instead of choosing a runtime target", () => {
    delete process.env.THREA_BASE_URL
    delete process.env.THREA_WORKSPACE_ID
    process.env.THREA_API_KEY = "standalone-key"

    expect(() =>
      runtimeSupervisorTargets(
        { baseUrl: "https://claude.example", workspaceId: "ws_claude" },
        { baseUrl: "https://pi.example", workspaceId: "ws_pi" }
      )
    ).toThrow("ambient Threa credentials match multiple runtime targets")
  })

  test("should preserve an explicit ambient identity when reviving a standalone root session", async () => {
    const { baseUrl, configs, requests } = startRuntimeServer()
    process.env.THREA_BASE_URL = baseUrl
    process.env.THREA_WORKSPACE_ID = WORKSPACE
    process.env.THREA_API_KEY = CLAUDE_KEY
    configs.claude.apiKey = "another-configured-claude-bot"
    const agent = { ...managedAgent("claude", baseUrl), activeStreamId: ROOT }

    expect(await reviveAgent(agent, {}, reviveDeps("claude", configs))).toEqual({
      status: "started",
      detail: "bypass enabled",
    })
    expect(requests).toEqual([
      {
        authorization: `Bearer ${CLAUDE_KEY}`,
        method: "GET",
        path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}`,
      },
      {
        authorization: `Bearer ${CLAUDE_KEY}`,
        method: "POST",
        path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions`,
      },
      {
        authorization: `Bearer ${CLAUDE_KEY}`,
        method: "GET",
        path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}`,
      },
    ])
  })

  for (const direction of [
    { parent: "claude" as const, child: "pi" as const },
    { parent: "pi" as const, child: "claude" as const },
  ]) {
    test(`should authenticate ${direction.child} revival HTTP as the child under a ${direction.parent} parent key`, async () => {
      const { baseUrl, configs, requests } = startRuntimeServer()
      process.env.THREA_BASE_URL = baseUrl
      process.env.THREA_WORKSPACE_ID = WORKSPACE
      process.env.THREA_API_KEY = direction.parent === "claude" ? CLAUDE_KEY : PI_KEY

      const outcome = await reviveAgent(
        managedAgent(direction.child, baseUrl),
        {},
        reviveDeps(direction.child, configs)
      )

      expect(outcome).toEqual({
        status: "started",
        detail: direction.child === "claude" ? "bypass enabled" : "Pi session reused",
      })
      const childAuthorization = `Bearer ${direction.child === "claude" ? CLAUDE_KEY : PI_KEY}`
      expect(requests).toEqual([
        {
          authorization: childAuthorization,
          method: "GET",
          path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}`,
        },
        {
          authorization: childAuthorization,
          method: "POST",
          path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions`,
        },
        {
          authorization: childAuthorization,
          method: "GET",
          path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}`,
        },
      ])
    })
  }
})
