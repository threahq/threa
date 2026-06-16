import { z } from "zod"
import type { Request, Response } from "express"
import type { WorkspaceIntegrationProvider } from "@threa/types"
import { WorkspaceIntegrationService } from "./service"
import { validateRequest } from "../../lib/validation"

const githubCallbackSchema = z.object({
  installation_id: z.string().min(1, "installation_id is required"),
  state: z.string().min(1, "state is required"),
})

const linearCallbackSchema = z.object({
  code: z.string().min(1, "code is required"),
  state: z.string().min(1, "state is required"),
})

interface Dependencies {
  workspaceIntegrationService: WorkspaceIntegrationService
  /** Origins the install callback may redirect to; anything else falls back to a relative redirect. */
  allowedFrontendOrigins: string[]
}

/**
 * Forwarded-host validation prevents an attacker-controlled `x-forwarded-host`
 * from turning the callback into an open redirect if the backend is reached
 * outside the trusted proxy chain; outside the allowlist we fall back to a
 * relative redirect.
 */
export function buildProviderCallbackRedirectUrl(
  req: Pick<Request, "headers" | "protocol">,
  workspaceId: string,
  provider: WorkspaceIntegrationProvider,
  allowedFrontendOrigins: string[]
): string {
  const path = `/w/${workspaceId}?ws-settings=integrations&provider=${provider}`
  const forwardedHost = getFirstHeaderValue(req.headers["x-forwarded-host"])
  if (!forwardedHost) {
    return path
  }

  const forwardedProto = getFirstHeaderValue(req.headers["x-forwarded-proto"]) ?? req.protocol
  const forwardedPort = getFirstHeaderValue(req.headers["x-forwarded-port"])
  const origin = buildForwardedOrigin(forwardedProto, forwardedHost, forwardedPort)
  if (!origin || !allowedFrontendOrigins.includes(origin)) {
    return path
  }
  return `${origin}${path}`
}

export function createWorkspaceIntegrationHandlers({
  workspaceIntegrationService,
  allowedFrontendOrigins,
}: Dependencies) {
  return {
    async getGithub(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const integration = await workspaceIntegrationService.getGithubIntegration(workspaceId)
      res.json({
        configured: workspaceIntegrationService.isGitHubEnabled(),
        integration,
      })
    },

    async connectGithub(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const connectUrl = workspaceIntegrationService.getGithubConnectUrl(workspaceId)
      res.redirect(connectUrl)
    },

    async disconnectGithub(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      await workspaceIntegrationService.disconnectGithubIntegration(workspaceId)
      res.status(204).send()
    },

    async syncGithub(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const integration = await workspaceIntegrationService.syncGithubRepositories(workspaceId)
      res.json({
        configured: workspaceIntegrationService.isGitHubEnabled(),
        integration,
      })
    },

    async githubCallback(req: Request, res: Response) {
      const query = validateRequest(githubCallbackSchema, req.query)

      const workosUserId = req.workosUserId!
      const { workspaceId } = await workspaceIntegrationService.handleGithubCallback({
        state: query.state,
        installationId: query.installation_id,
        workosUserId,
        viewerPermissions: req.authUser?.permissions ?? null,
      })

      res.redirect(buildProviderCallbackRedirectUrl(req, workspaceId, "github", allowedFrontendOrigins))
    },

    async getLinear(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const integration = await workspaceIntegrationService.getLinearIntegration(workspaceId)
      res.json({
        configured: workspaceIntegrationService.isLinearEnabled(),
        integration,
      })
    },

    async connectLinear(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const connectUrl = workspaceIntegrationService.getLinearConnectUrl(workspaceId)
      res.redirect(connectUrl)
    },

    async disconnectLinear(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      await workspaceIntegrationService.disconnectLinearIntegration(workspaceId)
      res.status(204).send()
    },

    async linearCallback(req: Request, res: Response) {
      const query = validateRequest(linearCallbackSchema, req.query)

      const workosUserId = req.workosUserId!
      const { workspaceId } = await workspaceIntegrationService.handleLinearCallback({
        state: query.state,
        code: query.code,
        workosUserId,
      })

      res.redirect(buildProviderCallbackRedirectUrl(req, workspaceId, "linear", allowedFrontendOrigins))
    },
  }
}

function getFirstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== "string") return null

  const first = raw
    .split(",")
    .map((part) => part.trim())
    .find(Boolean)

  return first ?? null
}

function buildForwardedOrigin(proto: string, host: string, port: string | null): string | null {
  try {
    const url = new URL(`${proto}://${host}`)
    if (port) {
      url.port = isDefaultPort(proto, port) ? "" : port
    }
    return url.origin
  } catch {
    return null
  }
}

function isDefaultPort(proto: string, port: string): boolean {
  return (proto === "http" && port === "80") || (proto === "https" && port === "443")
}
