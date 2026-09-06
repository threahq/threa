import type { NextFunction, Request, Response } from "express"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import type { WorkspacePermissionSlug } from "@threahq/types"
import { BOT_KEY_PREFIX } from "@threahq/types"
import { UserRepository } from "../features/workspaces"
import type { WorkspaceAuthzService } from "../features/workspace-authz"
import type { UserApiKeyService, ValidatedUserApiKey } from "../features/user-api-keys"
import type { BotApiKeyService, ValidatedBotApiKey } from "../features/public-api"

declare global {
  namespace Express {
    interface Request {
      /** Set when authenticated via a user-scoped API key */
      userApiKey?: ValidatedUserApiKey
      /** Set when authenticated via a bot API key */
      botApiKey?: ValidatedBotApiKey
    }
  }
}

interface PublicApiAuthDeps {
  userApiKeyService: UserApiKeyService
  botApiKeyService: BotApiKeyService
  workspaceAuthzService: WorkspaceAuthzService
  pool: Pool
}

export function createPublicApiAuthMiddleware({
  userApiKeyService,
  botApiKeyService,
  workspaceAuthzService,
  pool,
}: PublicApiAuthDeps) {
  return async function publicApiAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      next(new HttpError("Missing or invalid Authorization header", { status: 401, code: "UNAUTHORIZED" }))
      return
    }

    const token = authHeader.slice(7)
    const workspaceId = req.params.workspaceId
    if (!workspaceId) {
      next(new HttpError("Missing workspaceId", { status: 400, code: "BAD_REQUEST" }))
      return
    }

    if (token.startsWith("threa_uk_")) {
      const validated = await userApiKeyService.validateKey(token)
      if (!validated) {
        next(new HttpError("Invalid API key", { status: 401, code: "UNAUTHORIZED" }))
        return
      }

      if (validated.workspaceId !== workspaceId) {
        next(new HttpError("API key does not have access to this workspace", { status: 403, code: "FORBIDDEN" }))
        return
      }

      // Resolve workspace user for stream access checks
      const user = await UserRepository.findById(pool, workspaceId, validated.userId)
      if (!user) {
        next(new HttpError("API key does not have access to this workspace", { status: 403, code: "FORBIDDEN" }))
        return
      }

      // Clamp the key's stored scopes against the owner's current workspace
      // permissions (PR-3 INV-20 mirror). A user-scoped key minted while the
      // owner was admin must not retain admin-only scopes after demotion. If
      // the mirror row is missing or inactive the credential is no longer
      // usable — reject as 401 (owner-inactive), not 403, to distinguish from
      // a normal scope shortfall.
      const ownerPermissions = await workspaceAuthzService.resolveActivePermissions(workspaceId, user.workosUserId)
      if (ownerPermissions === null) {
        next(
          new HttpError("API key owner is no longer an active workspace member", {
            status: 401,
            code: "OWNER_INACTIVE",
          })
        )
        return
      }
      const ownerPermissionSet = new Set<string>(ownerPermissions)
      const effectiveScopes = new Set<string>()
      for (const scope of validated.scopes) {
        if (ownerPermissionSet.has(scope)) {
          effectiveScopes.add(scope)
        }
      }

      req.userApiKey = { ...validated, scopes: effectiveScopes }
      req.user = user
      req.workspaceId = workspaceId
      next()
      return
    }

    if (token.startsWith(BOT_KEY_PREFIX)) {
      const validated = await botApiKeyService.validateKey(token)
      if (!validated) {
        next(new HttpError("Invalid API key", { status: 401, code: "UNAUTHORIZED" }))
        return
      }

      if (validated.workspaceId !== workspaceId) {
        next(new HttpError("API key does not have access to this workspace", { status: 403, code: "FORBIDDEN" }))
        return
      }

      req.botApiKey = validated
      req.workspaceId = workspaceId
      next()
      return
    }

    next(new HttpError("Invalid API key", { status: 401, code: "UNAUTHORIZED" }))
  }
}

export function requireApiKeyScope(...scopes: WorkspacePermissionSlug[]) {
  return function requireScope(req: Request, _res: Response, next: NextFunction): void {
    if (req.userApiKey) {
      for (const scope of scopes) {
        if (!req.userApiKey.scopes.has(scope)) {
          next(new HttpError(`Missing required permission: ${scope}`, { status: 404, code: "NOT_FOUND" }))
          return
        }
      }
      next()
      return
    }

    if (req.botApiKey) {
      for (const scope of scopes) {
        if (!req.botApiKey.scopes.has(scope)) {
          next(new HttpError(`Missing required permission: ${scope}`, { status: 404, code: "NOT_FOUND" }))
          return
        }
      }
      next()
      return
    }

    next(new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" }))
  }
}
