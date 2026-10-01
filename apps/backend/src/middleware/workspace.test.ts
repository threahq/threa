import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { addLogDestination, attachPostHogLogShipping, logger } from "@threahq/backend-common"
import { createWorkspaceUserMiddleware } from "./workspace"
import { UserRepository } from "../features/workspaces"
import { ControlPlaneClient } from "../lib/control-plane-client"

const mockFindAccess = spyOn(UserRepository, "findWorkspaceUserAccess")

afterEach(() => {
  mockFindAccess.mockReset()
})

const POOL = {} as never

const AUTH_USER = {
  id: "workos_user_1",
  email: "user@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  permissions: null,
}

function createReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { workspaceId: "ws_1" },
    workosUserId: "workos_user_1",
    authUser: AUTH_USER,
    ...overrides,
  } as Request
}

interface RunResult {
  status: number | null
  body: unknown
  nextCalled: boolean
  req: Request
}

function runMiddleware(middleware: ReturnType<typeof createWorkspaceUserMiddleware>, req: Request): Promise<RunResult> {
  return new Promise((resolve) => {
    let status: number | null = null
    let body: unknown = null
    let settled = false
    const settle = (nextCalled: boolean) => {
      if (settled) return
      settled = true
      resolve({ status, body, nextCalled, req })
    }

    const res = {
      status(code: number) {
        status = code
        return this
      },
      json(payload: unknown) {
        body = payload
        settle(false)
        return this
      },
    } as unknown as Response

    const next: NextFunction = () => settle(true)

    Promise.resolve(middleware(req, res, next)).then(() => {
      if (!settled) settle(false)
    })
  })
}

function provisionedService(user: unknown) {
  return { ensureUserProvisioned: async () => user } as never
}

describe("createWorkspaceUserMiddleware", () => {
  test("passes through when there is no workspaceId param", async () => {
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: null,
    })
    const { nextCalled, status } = await runMiddleware(mw, createReq({ params: {} as Request["params"] }))

    expect(nextCalled).toBe(true)
    expect(status).toBeNull()
  })

  test("401 when not authenticated", async () => {
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: null,
    })
    const { status, nextCalled } = await runMiddleware(mw, createReq({ workosUserId: undefined }))

    expect(status).toBe(401)
    expect(nextCalled).toBe(false)
  })

  test("404 when the workspace does not exist", async () => {
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: false, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: null,
    })
    const { status } = await runMiddleware(mw, createReq())

    expect(status).toBe(404)
  })

  test("attaches the existing user and calls next", async () => {
    const user = { id: "usr_1", workspaceId: "ws_1" }
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: true, user: user as never })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: null,
    })
    const { nextCalled, req } = await runMiddleware(mw, createReq())

    expect(nextCalled).toBe(true)
    expect(req.user).toEqual(user as never)
    expect(req.workspaceId).toBe("ws_1")
  })

  test("403 when the user is missing and no control-plane client is configured", async () => {
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: true, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: null,
    })
    const { status } = await runMiddleware(mw, createReq())

    expect(status).toBe(403)
  })

  test("403 when the control plane reports the user is not a member", async () => {
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: true, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: { getWorkspaceMembership: async () => ({ member: false }) } as never,
    })
    const { status } = await runMiddleware(mw, createReq())

    expect(status).toBe(403)
  })

  test("403 (fail closed) when the control plane lookup throws", async () => {
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: true, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(null),
      controlPlaneClient: {
        getWorkspaceMembership: async () => {
          throw new Error("control-plane unreachable")
        },
      } as never,
    })
    const { status } = await runMiddleware(mw, createReq())

    expect(status).toBe(403)
  })

  test("self-heals and calls next when the control plane confirms membership", async () => {
    const healed = { id: "usr_healed", workspaceId: "ws_1" }
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: true, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService(healed),
      controlPlaneClient: { getWorkspaceMembership: async () => ({ member: true }) } as never,
    })
    const { nextCalled, status, req } = await runMiddleware(mw, createReq())

    expect(status).toBeNull()
    expect(nextCalled).toBe(true)
    expect(req.user).toEqual(healed as never)
    expect(req.workspaceId).toBe("ws_1")
  })

  test("logs and ships a self-heal without workspace, user or control-plane response content", async () => {
    const secrets = {
      failingWorkspace: "ws_01SECRETFAILING",
      healedWorkspace: "ws_01SECRETHEALED",
      workosUserId: "user_01SECRETWORKOS",
      healedUserId: "usr_01SECRETHEALED",
      internalKey: "internal-key-SECRET",
      body: "membership store down",
    }
    const controlPlane = Bun.serve({
      port: 0,
      fetch: (req) =>
        req.url.includes(secrets.failingWorkspace)
          ? new Response(`${secrets.body} for ${secrets.workosUserId}`, { status: 503 })
          : Response.json({ member: true }),
    })
    const lines: string[] = []
    addLogDestination({ level: "debug", stream: { write: (line: string) => void lines.push(line) } })
    const shipped: string[] = []
    const levelBefore = logger.level
    const shipper = attachPostHogLogShipping({
      config: { projectToken: "phc_test", host: "https://posthog.example.com", logsLevel: "debug" },
      service: "backend",
      region: null,
      environment: "test",
      flushIntervalMs: 50,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        shipped.push(String(init.body))
        return new Response(null, { status: 200 })
      }) as unknown as typeof fetch,
    })!
    mockFindAccess.mockResolvedValue({ workspaceExists: true, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService({ id: secrets.healedUserId, workspaceId: secrets.healedWorkspace }),
      controlPlaneClient: new ControlPlaneClient(`http://127.0.0.1:${controlPlane.port}`, secrets.internalKey),
    })
    const as = (workspaceId: string) =>
      createReq({ params: { workspaceId } as Request["params"], workosUserId: secrets.workosUserId })
    let results: Record<string, { status: number | null; nextCalled: boolean }>
    try {
      const failed = await runMiddleware(mw, as(secrets.failingWorkspace))
      const healed = await runMiddleware(mw, as(secrets.healedWorkspace))
      results = {
        failed: { status: failed.status, nextCalled: failed.nextCalled },
        healed: { status: healed.status, nextCalled: healed.nextCalled },
      }
    } finally {
      await controlPlane.stop(true)
      await shipper.flush()
      await shipper.shutdown()
      logger.level = levelBefore
    }
    const messages = [
      "Failed to confirm workspace membership with control plane",
      "Self-heal aborted: could not confirm workspace membership with control plane",
      "Self-healed missing regional user from control plane",
    ]
    const records = lines
      .flatMap((line) => line.split("\n"))
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => messages.includes(String(record.msg)))
      .map(({ time: _t, pid: _p, hostname: _h, ...rest }) => rest)
    const shippedText = shipped.join("\n")

    expect({ results, records, shipped: messages.map((msg) => shippedText.includes(msg)) }).toEqual({
      results: { failed: { status: 403, nextCalled: false }, healed: { status: null, nextCalled: true } },
      records: [
        { level: 50, status: 503, msg: messages[0] },
        { level: 50, errorCode: null, msg: messages[1] },
        { level: 30, msg: messages[2] },
      ],
      shipped: [true, true, true],
    })
    const everything = [lines.join("\n"), shippedText].join("\n")
    expect(Object.values(secrets).filter((secret) => everything.includes(secret))).toEqual([])
  })

  test("403 when the user is missing and there is no WorkOS identity to provision from", async () => {
    mockFindAccess.mockResolvedValueOnce({ workspaceExists: true, user: null })
    const mw = createWorkspaceUserMiddleware({
      pool: POOL,
      workspaceService: provisionedService({ id: "usr_x" }),
      controlPlaneClient: { getWorkspaceMembership: async () => ({ member: true }) } as never,
    })
    const { status } = await runMiddleware(mw, createReq({ authUser: undefined }))

    expect(status).toBe(403)
  })
})
