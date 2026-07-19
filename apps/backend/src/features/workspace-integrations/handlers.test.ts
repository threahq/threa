import { describe, expect, test } from "bun:test"
import type { Request, Response } from "express"
import { buildProviderCallbackRedirectUrl, createWorkspaceIntegrationHandlers } from "./handlers"
import type { WorkspaceIntegrationService } from "./service"

interface CapturedResponse {
  statusCode: number | null
  body: unknown
  sent: boolean
}

function fakeRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: null, body: undefined, sent: false }
  const res = {
    json(body: unknown) {
      captured.body = body
      return this
    },
    status(code: number) {
      captured.statusCode = code
      return this
    },
    send() {
      captured.sent = true
      return this
    },
  } as unknown as Response
  return { res, captured }
}

function makeHandlers(service: Partial<WorkspaceIntegrationService>) {
  return createWorkspaceIntegrationHandlers({
    workspaceIntegrationService: service as WorkspaceIntegrationService,
    allowedFrontendOrigins: [],
  })
}

describe("github integration handlers", () => {
  test("getGithub responds with { configured, integrations }", async () => {
    const integrations = [{ id: "wsi_1" }]
    const handlers = makeHandlers({
      isGitHubEnabled: () => true,
      listGithubInstallations: async () => integrations as never,
    })
    const { res, captured } = fakeRes()
    await handlers.getGithub({ workspaceId: "ws_1" } as unknown as Request, res)
    expect(captured.body).toEqual({ configured: true, integrations })
  })

  test("disconnectGithub validates integrationId param and delegates to the per-install service", async () => {
    let received: { workspaceId?: string; integrationId?: string } = {}
    const handlers = makeHandlers({
      disconnectGithubInstallation: async (workspaceId: string, integrationId: string) => {
        received = { workspaceId, integrationId }
      },
    })
    const { res, captured } = fakeRes()
    await handlers.disconnectGithub(
      { workspaceId: "ws_1", params: { integrationId: "wsi_9" } } as unknown as Request,
      res
    )
    expect(received).toEqual({ workspaceId: "ws_1", integrationId: "wsi_9" })
    expect(captured.statusCode).toBe(204)
    expect(captured.sent).toBe(true)
  })

  test("disconnectGithub rejects a missing integrationId param", async () => {
    const handlers = makeHandlers({ disconnectGithubInstallation: async () => {} })
    const { res } = fakeRes()
    await expect(
      handlers.disconnectGithub({ workspaceId: "ws_1", params: {} } as unknown as Request, res)
    ).rejects.toThrow()
  })

  test("syncGithub re-lists installations after syncing the addressed one", async () => {
    const calls: string[] = []
    const integrations = [{ id: "wsi_1" }]
    const handlers = makeHandlers({
      isGitHubEnabled: () => true,
      syncGithubRepositories: async (_ws: string, integrationId: string) => {
        calls.push(`sync:${integrationId}`)
        return {} as never
      },
      listGithubInstallations: async () => {
        calls.push("list")
        return integrations as never
      },
    })
    const { res, captured } = fakeRes()
    await handlers.syncGithub({ workspaceId: "ws_1", params: { integrationId: "wsi_1" } } as unknown as Request, res)
    expect(calls).toEqual(["sync:wsi_1", "list"])
    expect(captured.body).toEqual({ configured: true, integrations })
  })
})

describe("buildProviderCallbackRedirectUrl (github)", () => {
  const allowedOrigins = ["http://localhost:3000", "https://app.threa.io"]

  test("returns an absolute frontend URL when the forwarded origin is allowlisted", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {
          "x-forwarded-host": "localhost:3000",
          "x-forwarded-proto": "http",
        },
        protocol: "http",
      } as any,
      "ws_123",
      "github",
      allowedOrigins
    )

    expect(url).toBe("http://localhost:3000/w/ws_123?ws-settings=integrations&provider=github")
  })

  test("prefers x-forwarded-port over an intermediate proxy port in the host header", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {
          "x-forwarded-host": "localhost:3001",
          "x-forwarded-proto": "http",
          "x-forwarded-port": "3000",
        },
        protocol: "http",
      } as any,
      "ws_123",
      "github",
      allowedOrigins
    )

    expect(url).toBe("http://localhost:3000/w/ws_123?ws-settings=integrations&provider=github")
  })

  test("falls back to a relative workspace path without forwarded headers", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {},
        protocol: "https",
      } as any,
      "ws_123",
      "github",
      allowedOrigins
    )

    expect(url).toBe("/w/ws_123?ws-settings=integrations&provider=github")
  })

  test("falls back to a relative path when the forwarded origin is not in the allowlist", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        },
        protocol: "https",
      } as any,
      "ws_123",
      "github",
      allowedOrigins
    )

    expect(url).toBe("/w/ws_123?ws-settings=integrations&provider=github")
  })

  test("falls back to a relative path when the forwarded host is malformed", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {
          "x-forwarded-host": "not a valid host",
          "x-forwarded-proto": "https",
        },
        protocol: "https",
      } as any,
      "ws_123",
      "github",
      allowedOrigins
    )

    expect(url).toBe("/w/ws_123?ws-settings=integrations&provider=github")
  })
})

describe("buildProviderCallbackRedirectUrl (linear)", () => {
  const allowedOrigins = ["http://localhost:3000", "https://app.threa.io"]

  test("returns an absolute frontend URL with provider=linear when the forwarded origin is allowlisted", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {
          "x-forwarded-host": "app.threa.io",
          "x-forwarded-proto": "https",
        },
        protocol: "https",
      } as any,
      "ws_abc",
      "linear",
      allowedOrigins
    )

    expect(url).toBe("https://app.threa.io/w/ws_abc?ws-settings=integrations&provider=linear")
  })

  test("falls back to a relative workspace path with provider=linear when the forwarded origin is not allowlisted", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        },
        protocol: "https",
      } as any,
      "ws_abc",
      "linear",
      allowedOrigins
    )

    expect(url).toBe("/w/ws_abc?ws-settings=integrations&provider=linear")
  })

  test("falls back to a relative path with provider=linear when no forwarded headers are present", () => {
    const url = buildProviderCallbackRedirectUrl(
      {
        headers: {},
        protocol: "https",
      } as any,
      "ws_abc",
      "linear",
      allowedOrigins
    )

    expect(url).toBe("/w/ws_abc?ws-settings=integrations&provider=linear")
  })
})
