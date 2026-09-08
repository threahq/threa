import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultDoneDeps, doneAgent, type DoneDeps } from "./done"
import { DEFAULT_PROFILE } from "./profiles"
import { defaultAttachedSpawnDeps } from "./spawn-attached"
import { linkAttachedThread, requireThreadSessionTarget, type RuntimeTargetResolver } from "./spawners"
import type { ManagedAgent, RuntimeKind, ThreaChannelConfig } from "./types"

const WORKSPACE = "ws_test"
const ROOT = "stream_root"
const THREAD = "stream_thread"
const CLAUDE_KEY = "claude-key"
const PI_KEY = "pi-key"

interface RequestRecord {
  authorization: string | null
  path: string
  body: Record<string, unknown>
}

interface SessionRecord {
  activeStreamId: string
  rootStreamId: string
}

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

function startBotScopedServer() {
  const requests: RequestRecord[] = []
  const sessions = new Map<string, SessionRecord>()
  const sessionKey = (authorization: string | null, instanceId: unknown, runtimeSessionId: unknown) =>
    `${authorization}:${String(instanceId)}:${String(runtimeSessionId)}`

  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const authorization = request.headers.get("authorization")
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ authorization, path: url.pathname, body })

      if (url.pathname === `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions`) {
        const runtimeKind = body.runtimeKind
        const expected = runtimeKind === "pi-local" ? `Bearer ${PI_KEY}` : `Bearer ${CLAUDE_KEY}`
        if (authorization !== expected) return new Response("wrong bot", { status: 403 })
        sessions.set(sessionKey(authorization, body.instanceId, body.runtimeSessionId), {
          activeStreamId: THREAD,
          rootStreamId: ROOT,
        })
        return Response.json({ data: { rootStreamId: ROOT, activeStreamId: THREAD } })
      }

      if (
        url.pathname === `/api/v1/workspaces/${WORKSPACE}/streams/${THREAD}/messages` ||
        url.pathname === `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}/messages`
      ) {
        const knownBot = authorization === `Bearer ${PI_KEY}` || authorization === `Bearer ${CLAUDE_KEY}`
        return knownBot
          ? Response.json({ data: { id: "msg_notice" } }, { status: 201 })
          : new Response("wrong bot", { status: 403 })
      }

      if (
        url.pathname === `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions/brief` ||
        url.pathname === `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions/end`
      ) {
        const key = sessionKey(authorization, body.instanceId, body.runtimeSessionId)
        const linked = sessions.get(key)
        if (!linked) return new Response("session not found for bot", { status: 404 })
        if (url.pathname.endsWith("/brief")) return new Response(null, { status: 204 })
        sessions.delete(key)
        return Response.json({ data: { activeStreamId: linked.activeStreamId } })
      }

      return new Response("not found", { status: 404 })
    },
  })

  const baseUrl = `http://127.0.0.1:${server.port}`
  const configs: Record<RuntimeKind, ThreaChannelConfig> = {
    claude: { baseUrl, workspaceId: WORKSPACE, apiKey: CLAUDE_KEY },
    pi: { baseUrl, workspaceId: WORKSPACE, apiKey: PI_KEY },
  }
  const targetForRuntime: RuntimeTargetResolver = (runtime, purpose) =>
    requireThreadSessionTarget(configs[runtime], purpose)
  return { requests, sessions, configs, targetForRuntime }
}

describe("runtime-scoped production HTTP wiring", () => {
  for (const direction of [
    { parent: "claude" as const, child: "pi" as const, instanceId: "pi-child", runtimeSessionId: "pi-session" },
    {
      parent: "pi" as const,
      child: "claude" as const,
      instanceId: "claude-child",
      runtimeSessionId: "claude-session",
    },
  ]) {
    test(`should use the ${direction.child} bot for attach, brief, and end under a ${direction.parent} root`, async () => {
      const { requests, sessions, configs, targetForRuntime } = startBotScopedServer()
      const parentAuthorization = `Bearer ${direction.parent === "pi" ? PI_KEY : CLAUDE_KEY}`
      const childAuthorization = `Bearer ${direction.child === "pi" ? PI_KEY : CLAUDE_KEY}`
      const parentKey = `${parentAuthorization}:${direction.parent}-root:${direction.parent}-root-session`
      sessions.set(parentKey, { activeStreamId: ROOT, rootStreamId: ROOT })

      const linked = await linkAttachedThread({
        config: configs[direction.child],
        purpose: `link the ${direction.child} thread session`,
        runtimeKind: direction.child === "pi" ? "pi-local" : "claude-code-channel",
        instanceId: direction.instanceId,
        runtimeSessionId: direction.runtimeSessionId,
        worktree: `/repo/${direction.child}-child`,
        attach: { rootStreamId: ROOT, anchorId: "msg_anchor" },
      })
      expect(linked.activeStreamId).toBe(THREAD)

      const spawnDeps = defaultAttachedSpawnDeps(targetForRuntime)
      await spawnDeps.brief({
        runtime: direction.child,
        instanceId: direction.instanceId,
        runtimeSessionId: direction.runtimeSessionId,
        content: "child brief",
      })

      const doneDeps = defaultDoneDeps(targetForRuntime, targetForRuntime(direction.child, "test supervisor"))
      await expect(
        doneDeps.endSession({
          runtime: direction.child,
          instanceId: direction.instanceId,
          runtimeSessionId: direction.runtimeSessionId,
        })
      ).resolves.toEqual({ status: "ended", activeStreamId: THREAD })

      expect(requests.map(({ authorization, path }) => ({ authorization, path }))).toEqual([
        {
          authorization: childAuthorization,
          path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions`,
        },
        {
          authorization: childAuthorization,
          path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions/brief`,
        },
        {
          authorization: childAuthorization,
          path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/sessions/end`,
        },
      ])
      expect(sessions.has(parentKey)).toBe(true)
    })
  }

  test("should keep runtime lifecycle and notice credentials scoped through the default dependencies", async () => {
    const { requests, sessions, targetForRuntime } = startBotScopedServer()
    const home = mkdtempSync(join(tmpdir(), "harnessd-runtime-credentials-"))
    try {
      mkdirSync(join(home, ".claude", "threa-channel"), { recursive: true })
      mkdirSync(join(home, ".pi", "agent"), { recursive: true })
      const baseUrl = targetForRuntime("pi", "test config").baseUrl
      writeFileSync(
        join(home, ".claude", "threa-channel", "config.json"),
        JSON.stringify({ baseUrl, workspaceId: WORKSPACE, apiKey: CLAUDE_KEY })
      )
      writeFileSync(
        join(home, ".pi", "agent", "threa-remote.json"),
        JSON.stringify({ baseUrl, workspaceId: WORKSPACE, apiKey: PI_KEY })
      )
      const script = `
        import { defaultDoneDeps } from "./src/done.ts";
        import { defaultAttachedSpawnDeps, runAttachedSpawn } from "./src/spawn-attached.ts";
        import { linkAttachedThread, readPiRemoteConfig, readThreaChannelConfig } from "./src/spawners.ts";
        for (const runtime of ["pi", "claude"]) {
          process.env.THREA_API_KEY = runtime === "pi" ? "${CLAUDE_KEY}" : "${PI_KEY}";
          const instanceId = runtime + "-default-child";
          const runtimeSessionId = runtime + "-default-session";
          const config = runtime === "pi" ? readPiRemoteConfig() : readThreaChannelConfig();
          await linkAttachedThread({
            config,
            purpose: "link the " + runtime + " thread session",
            runtimeKind: runtime === "pi" ? "pi-local" : "claude-code-channel",
            instanceId,
            runtimeSessionId,
            worktree: "/repo/" + runtime + "-default-child",
            attach: { rootStreamId: "${ROOT}", anchorId: "msg_anchor" },
          });
          await defaultAttachedSpawnDeps().brief({ runtime, instanceId, runtimeSessionId, content: "child brief" });
          await defaultDoneDeps().endSession({ runtime, instanceId, runtimeSessionId });

          const promptless = defaultAttachedSpawnDeps();
          promptless.spawn = async () => ({
            worktree: "/repo/child",
            branch: "child",
            tmuxSession: "agents",
            tmuxWindow: "child",
            activeStreamId: "${THREAD}",
            output: "",
          });
          await runAttachedSpawn({ runtime, name: runtime + "-child", attach: { rootStreamId: "${ROOT}", anchorId: "msg_anchor" } }, promptless);
          const failed = defaultAttachedSpawnDeps();
          failed.spawn = async () => { throw new Error("synthetic spawn failure"); };
          await runAttachedSpawn({ runtime, name: runtime + "-child", attach: { rootStreamId: "${ROOT}", anchorId: "msg_anchor" } }, failed).catch(() => {});
        }
      `
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: home,
          THREA_API_KEY: "ambient-parent-key",
          THREA_BASE_URL: baseUrl,
          THREA_WORKSPACE_ID: WORKSPACE,
        },
        stdout: "ignore",
        stderr: "pipe",
      })
      const exitCode = await child.exited
      const stderr = await new Response(child.stderr).text()
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })

      expect(requests.map(({ authorization, path }) => ({ authorization, path }))).toEqual([
        ...["sessions", "sessions/brief", "sessions/end"].map((suffix) => ({
          authorization: `Bearer ${PI_KEY}`,
          path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/${suffix}`,
        })),
        { authorization: `Bearer ${PI_KEY}`, path: `/api/v1/workspaces/${WORKSPACE}/streams/${THREAD}/messages` },
        { authorization: `Bearer ${CLAUDE_KEY}`, path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}/messages` },
        ...["sessions", "sessions/brief", "sessions/end"].map((suffix) => ({
          authorization: `Bearer ${CLAUDE_KEY}`,
          path: `/api/v1/workspaces/${WORKSPACE}/bot-runtime/${suffix}`,
        })),
        { authorization: `Bearer ${CLAUDE_KEY}`, path: `/api/v1/workspaces/${WORKSPACE}/streams/${THREAD}/messages` },
        { authorization: `Bearer ${PI_KEY}`, path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}/messages` },
      ])
      expect(requests.filter(({ path }) => path.endsWith("/messages"))).toEqual(
        (["pi", "claude"] as const).flatMap((runtime) => [
          {
            authorization: `Bearer ${runtime === "pi" ? PI_KEY : CLAUDE_KEY}`,
            path: `/api/v1/workspaces/${WORKSPACE}/streams/${THREAD}/messages`,
            body: {
              content: `**${runtime}-child** is running in \`/repo/child\` (tmux \`child\`). No prompt came with \`/spawn\` — reply here to give it one.`,
            },
          },
          {
            authorization: `Bearer ${runtime === "pi" ? CLAUDE_KEY : PI_KEY}`,
            path: `/api/v1/workspaces/${WORKSPACE}/streams/${ROOT}/messages`,
            body: { content: `harnessd: spawn of \`${runtime}-child\` failed: synthetic spawn failure` },
          },
        ])
      )
      expect(sessions.size).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("should leave the exact child session retryable when end uses the wrong bot", async () => {
    const { sessions, configs, targetForRuntime } = startBotScopedServer()
    const identity = { runtime: "pi" as const, instanceId: "pi-child", runtimeSessionId: "pi-session" }
    await linkAttachedThread({
      config: configs.pi,
      purpose: "link the Pi thread session",
      runtimeKind: "pi-local",
      instanceId: identity.instanceId,
      runtimeSessionId: identity.runtimeSessionId,
      worktree: "/repo/pi-child",
      attach: { rootStreamId: ROOT, anchorId: "msg_anchor" },
    })

    const wrongIdentity: RuntimeTargetResolver = () => requireThreadSessionTarget(configs.claude, "wrong identity")
    const wrongDeps = defaultDoneDeps(wrongIdentity, targetForRuntime("pi", "test supervisor"))
    const persisted: ManagedAgent[] = []
    const notices: string[] = []
    const agent: ManagedAgent = {
      id: "pi-child",
      name: "pi-child",
      runtime: "pi",
      status: "online",
      worktree: "/repo/pi-child",
      instanceId: identity.instanceId,
      runtimeSessionId: identity.runtimeSessionId,
      scratchpadUrl: `${configs.pi.baseUrl}/w/${WORKSPACE}/s/${ROOT}`,
      command: [],
      createdAt: "2026-09-07T00:00:00.000Z",
      updatedAt: "2026-09-07T00:00:00.000Z",
    }
    const deps: DoneDeps = {
      endSession: wrongDeps.endSession,
      profileFor: () => DEFAULT_PROFILE,
      teardown: () => ({ ok: true }),
      windDown: () => ({ pushed: false, removed: false }),
      killWindow: () => {},
      awaitExit: async () => {},
      log: () => {},
      findAgent: () => agent,
      links: () => [
        {
          runtimeKind: "pi-local",
          runtimeSessionId: identity.runtimeSessionId,
          instanceId: identity.instanceId,
          rootStreamId: ROOT,
          worktree: agent.worktree!,
          pid: 0,
          updatedAt: agent.updatedAt,
        },
      ],
      panes: () => [],
      identities: () => [],
      claudeProcessesIn: () => [],
      pathExists: () => false,
      canonicalPath: (path: string) => path,
      forgetLink: () => {},
      forgetIdentities: () => [],
      lock: async () => () => {},
      persist: (next: ManagedAgent) => persisted.push(next),
      postNotice: async (streamId: string, content: string) => void notices.push(`${streamId}:${content}`),
    }

    await expect(doneAgent({ ref: agent.id, rootStreamId: ROOT }, deps)).rejects.toThrow(
      "404 session not found for bot"
    )
    expect(persisted).toEqual([
      {
        ...agent,
        status: "stopped",
        updatedAt: persisted[0]?.updatedAt,
      },
    ])
    expect(notices).toEqual([
      `${ROOT}:harnessd: \`/done\` for \`pi-child\` failed: harnessd: remote cleanup unresolved: could not end runtime session: 404 session not found for bot`,
    ])
    expect(sessions.has(`Bearer ${PI_KEY}:${identity.instanceId}:${identity.runtimeSessionId}`)).toBe(true)

    const retryDeps = defaultDoneDeps(targetForRuntime, targetForRuntime("pi", "test supervisor"))
    await expect(retryDeps.endSession(identity)).resolves.toEqual({ status: "ended", activeStreamId: THREAD })
  })
})
