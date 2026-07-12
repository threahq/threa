import { describe, expect, test } from "bun:test"
import type { NextFunction, Request, Response } from "express"
import { createPublicApiAuthMiddleware, requireApiKeyScope } from "./public-api-auth"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"

function createPoolStub() {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
  } as any
}

function createReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    ...overrides,
  } as Request
}

interface CapturedError {
  message: string
  status: number
  code?: string
}

function runMiddleware(middleware: any, req: Request): Promise<{ nextCalled: boolean; error: CapturedError | null }> {
  return new Promise((resolve) => {
    let nextCalled = false
    let error: CapturedError | null = null

    const next: NextFunction = (err?: any) => {
      nextCalled = true
      if (err) {
        error = { message: err.message, status: err.status, code: err.code }
      }
      resolve({ nextCalled, error })
    }

    const res = {} as Response
    const result = middleware(req, res, next)
    if (result && typeof result.then === "function") {
      result.then(() => {
        if (!nextCalled) resolve({ nextCalled, error })
      })
    }
  })
}

describe("createPublicApiAuthMiddleware", () => {
  function createMiddleware(
    overrides: {
      userApiKeyService?: any
      botApiKeyService?: any
      workspaceAuthzService?: any
      pool?: any
      ownerPermissions?: string[] | null
    } = {}
  ) {
    const { ownerPermissions, workspaceAuthzService, ...rest } = overrides
    const defaultAuthz =
      workspaceAuthzService ??
      ({
        resolveActivePermissions: async () =>
          ownerPermissions === undefined ? ["messages:read", "members:write", "workspace:admin"] : ownerPermissions,
      } as any)
    return createPublicApiAuthMiddleware({
      userApiKeyService: { validateKey: async () => null } as any,
      botApiKeyService: { validateKey: async () => null } as any,
      workspaceAuthzService: defaultAuthz,
      pool: createPoolStub(),
      ...rest,
    })
  }

  test("should return 401 for missing Authorization header", async () => {
    const middleware = createMiddleware()
    const req = createReq({ params: { workspaceId: "ws_1" } })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(401)
  })

  test("should return 401 for non-Bearer Authorization header", async () => {
    const middleware = createMiddleware()
    const req = createReq({
      headers: { authorization: "Basic abc123" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(401)
  })

  test("should return 401 for unrecognized key prefix", async () => {
    const middleware = createMiddleware()
    const req = createReq({
      headers: { authorization: "Bearer unknown_prefix_key" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(401)
  })

  function userRow(role = "admin") {
    return {
      id: "user_1",
      workspace_id: "ws_1",
      name: "Test User",
      email: "test@example.com",
      role,
      slug: "test",
      workos_user_id: "wos_1",
      description: null,
      avatar_url: null,
      timezone: null,
      locale: null,
      pronouns: null,
      phone: null,
      github_username: null,
      setup_completed: true,
      joined_at: new Date(),
    }
  }

  test("should authenticate valid user-scoped key", async () => {
    const middleware = createMiddleware({
      userApiKeyService: {
        validateKey: async (token: string) =>
          token === "threa_uk_testkey123"
            ? { id: "uak_1", workspaceId: "ws_1", userId: "user_1", name: "My Key", scopes: new Set(["messages:read"]) }
            : null,
      },
      pool: { query: async () => ({ rows: [userRow("admin")], rowCount: 1 }) } as any,
    })

    const req = createReq({
      headers: { authorization: "Bearer threa_uk_testkey123" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { nextCalled, error } = await runMiddleware(middleware, req)

    expect(nextCalled).toBe(true)
    expect(error).toBeNull()
    expect(req.userApiKey).toBeDefined()
    expect(req.userApiKey!.id).toBe("uak_1")
    expect(req.userApiKey!.scopes.has("messages:read")).toBe(true)
    expect(req.workspaceId).toBe("ws_1")
  })

  test("clamps user-key scopes against the workspace_user_permissions mirror", async () => {
    const middleware = createMiddleware({
      userApiKeyService: {
        validateKey: async () => ({
          id: "uak_1",
          workspaceId: "ws_1",
          userId: "user_1",
          name: "My Key",
          // Key was minted while owner was admin; persisted scopes include
          // admin-only members:write alongside member-tier messages:read.
          scopes: new Set(["messages:read", "members:write"]),
        }),
      },
      pool: { query: async () => ({ rows: [userRow("member")], rowCount: 1 }) } as any,
      // Owner is now a member — admin-only scopes must fall away on this request.
      ownerPermissions: ["messages:read"],
    })

    const req = createReq({
      headers: { authorization: "Bearer threa_uk_testkey123" } as any,
      params: { workspaceId: "ws_1" },
    })
    await runMiddleware(middleware, req)

    expect(req.userApiKey).toBeDefined()
    expect(req.userApiKey!.scopes.has("messages:read")).toBe(true)
    expect(req.userApiKey!.scopes.has("members:write")).toBe(false)
  })

  test("rejects user-key with 401 OWNER_INACTIVE when mirror row missing", async () => {
    const middleware = createMiddleware({
      userApiKeyService: {
        validateKey: async () => ({
          id: "uak_1",
          workspaceId: "ws_1",
          userId: "user_1",
          name: "My Key",
          scopes: new Set(["messages:read"]),
        }),
      },
      pool: { query: async () => ({ rows: [userRow("member")], rowCount: 1 }) } as any,
      ownerPermissions: null,
    })

    const req = createReq({
      headers: { authorization: "Bearer threa_uk_testkey123" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(401)
    expect(error!.code).toBe("OWNER_INACTIVE")
  })

  test("should return 403 for user key from wrong workspace", async () => {
    const middleware = createMiddleware({
      userApiKeyService: {
        validateKey: async () => ({
          id: "uak_1",
          workspaceId: "ws_other",
          userId: "user_1",
          name: "My Key",
          scopes: new Set(["messages:read"]),
        }),
      },
    })

    const req = createReq({
      headers: { authorization: "Bearer threa_uk_testkey123" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(403)
  })

  test("should authenticate valid bot-scoped key", async () => {
    const middleware = createMiddleware({
      botApiKeyService: {
        validateKey: async (token: string) =>
          token === "threa_bk_testkey123"
            ? { id: "bak_1", workspaceId: "ws_1", botId: "bot_1", name: "Bot Key", scopes: new Set(["messages:write"]) }
            : null,
      },
    })

    const req = createReq({
      headers: { authorization: "Bearer threa_bk_testkey123" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { nextCalled, error } = await runMiddleware(middleware, req)

    expect(nextCalled).toBe(true)
    expect(error).toBeNull()
    expect(req.botApiKey).toBeDefined()
    expect(req.botApiKey!.botId).toBe("bot_1")
    expect(req.workspaceId).toBe("ws_1")
  })

  test("should return 403 for bot key from wrong workspace", async () => {
    const middleware = createMiddleware({
      botApiKeyService: {
        validateKey: async () => ({
          id: "bak_1",
          workspaceId: "ws_other",
          botId: "bot_1",
          name: "Bot Key",
          scopes: new Set(["messages:write"]),
        }),
      },
    })

    const req = createReq({
      headers: { authorization: "Bearer threa_bk_testkey123" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(403)
  })

  test("should return 401 for invalid bot key", async () => {
    const middleware = createMiddleware()
    const req = createReq({
      headers: { authorization: "Bearer threa_bk_invalid" } as any,
      params: { workspaceId: "ws_1" },
    })
    const { error } = await runMiddleware(middleware, req)

    expect(error).not.toBeNull()
    expect(error!.status).toBe(401)
  })
})

describe("requireApiKeyScope", () => {
  test("should pass when user key has required scope", () => {
    const middleware = requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH)
    const req = createReq()
    req.userApiKey = {
      id: "uak_1",
      workspaceId: "ws_1",
      userId: "user_1",
      name: "Test",
      scopes: new Set(["messages:search"]),
      apiVersion: "2026-07-12",
    }

    let nextCalled = false
    let error: any = null
    const next: NextFunction = (err?: any) => {
      nextCalled = true
      error = err
    }
    middleware(req, {} as Response, next)

    expect(nextCalled).toBe(true)
    expect(error).toBeUndefined()
  })

  test("should pass when bot key has required scope", () => {
    const middleware = requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE)
    const req = createReq()
    req.botApiKey = {
      id: "bak_1",
      workspaceId: "ws_1",
      botId: "bot_1",
      name: "Bot Key",
      scopes: new Set(["messages:write"]),
      apiVersion: "2026-07-12",
    }

    let nextCalled = false
    let error: any = null
    const next: NextFunction = (err?: any) => {
      nextCalled = true
      error = err
    }
    middleware(req, {} as Response, next)

    expect(nextCalled).toBe(true)
    expect(error).toBeUndefined()
  })

  test("should return 404 when scope is missing from user key", () => {
    const middleware = requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH)
    const req = createReq()
    req.userApiKey = {
      id: "uak_1",
      workspaceId: "ws_1",
      userId: "user_1",
      name: "Test",
      scopes: new Set(["streams:read"]),
      apiVersion: "2026-07-12",
    }

    let error: any = null
    const next: NextFunction = (err?: any) => {
      error = err
    }
    middleware(req, {} as Response, next)

    expect(error).not.toBeNull()
    expect(error.status).toBe(404)
  })

  test("should return 404 when scope is missing from bot key", () => {
    const middleware = requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE)
    const req = createReq()
    req.botApiKey = {
      id: "bak_1",
      workspaceId: "ws_1",
      botId: "bot_1",
      name: "Bot Key",
      scopes: new Set(["messages:read"]),
      apiVersion: "2026-07-12",
    }

    let error: any = null
    const next: NextFunction = (err?: any) => {
      error = err
    }
    middleware(req, {} as Response, next)

    expect(error).not.toBeNull()
    expect(error.status).toBe(404)
  })

  test("should return 401 when no key context on request", () => {
    const middleware = requireApiKeyScope(WORKSPACE_PERMISSION_SCOPES.MESSAGES_SEARCH)
    const req = createReq()

    let error: any = null
    const next: NextFunction = (err?: any) => {
      error = err
    }
    middleware(req, {} as Response, next)

    expect(error).not.toBeNull()
    expect(error.status).toBe(401)
  })
})
