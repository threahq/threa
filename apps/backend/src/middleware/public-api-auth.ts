import type { NextFunction, Request, Response } from "express"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import type { WorkspacePermissionSlug } from "@threahq/types"
import { BOT_KEY_PREFIX } from "@threahq/types"
import { UserRepository } from "../features/workspaces"
import type { WorkspaceAuthzService } from "../features/workspace-authz"
import type { UserApiKeyService, ValidatedUserApiKey } from "../features/user-api-keys"
import type { BotApiKeyService, ValidatedBotApiKey, OperationId } from "../features/public-api"
import { SANDBOX_TOKEN_PREFIX, type SandboxSession, type SandboxSessionTokenService } from "../features/sandboxes"

declare global {
  namespace Express {
    interface Request {
      /** Set when authenticated via a user-scoped API key */
      userApiKey?: ValidatedUserApiKey
      /** Set when authenticated via a bot API key */
      botApiKey?: ValidatedBotApiKey
      /**
       * Set when authenticated via a sandbox token. Never paired with
       * `req.user`, so no handler branch meant for user keys runs with the
       * invoking user's full reach. `scopes` is the invoker's current
       * workspace permissions.
       */
      sandboxSession?: SandboxSession & { scopes: ReadonlySet<string> }
    }
  }
}

interface PublicApiAuthDeps {
  userApiKeyService: UserApiKeyService
  botApiKeyService: BotApiKeyService
  sandboxSessionTokenService: SandboxSessionTokenService
  workspaceAuthzService: WorkspaceAuthzService
  pool: Pool
}

export function createPublicApiAuthMiddleware({
  userApiKeyService,
  botApiKeyService,
  sandboxSessionTokenService,
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

    if (token.startsWith(SANDBOX_TOKEN_PREFIX)) {
      const session = await sandboxSessionTokenService.validate(token)
      if (!session) {
        next(new HttpError("Invalid API key", { status: 401, code: "UNAUTHORIZED" }))
        return
      }

      if (session.workspaceId !== workspaceId) {
        next(new HttpError("API key does not have access to this workspace", { status: 403, code: "FORBIDDEN" }))
        return
      }

      const invoker = await UserRepository.findById(pool, workspaceId, session.invokingUserId)
      const invokerPermissions = invoker
        ? await workspaceAuthzService.resolveActivePermissions(workspaceId, invoker.workosUserId)
        : null
      if (invokerPermissions === null) {
        next(
          new HttpError("API key owner is no longer an active workspace member", {
            status: 401,
            code: "OWNER_INACTIVE",
          })
        )
        return
      }

      req.sandboxSession = { ...session, scopes: new Set(invokerPermissions) }
      req.workspaceId = workspaceId
      next()
      return
    }

    next(new HttpError("Invalid API key", { status: 401, code: "UNAUTHORIZED" }))
  }
}

/**
 * What code in an agent's sandbox may call: reading the streams and files of
 * the turn that minted its token, and uploading output files. Everything else
 * answers 404, like a missing scope. Signed download URLs stay out: a URL is a
 * bearer credential that would outlive the token.
 */
const SANDBOX_OPERATIONS: ReadonlySet<OperationId> = new Set<OperationId>([
  "searchMessages",
  "listStreams",
  "getStream",
  "listMessages",
  "searchAttachments",
  "getAttachment",
  "downloadAttachment",
  "uploadAttachment",
])

export function requireSandboxOperation(operationId: OperationId) {
  return function sandboxOperationGuard(req: Request, _res: Response, next: NextFunction): void {
    if (req.sandboxSession && !SANDBOX_OPERATIONS.has(operationId)) {
      next(new HttpError("Not found", { status: 404, code: "NOT_FOUND" }))
      return
    }
    next()
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

    if (req.sandboxSession) {
      for (const scope of scopes) {
        if (!req.sandboxSession.scopes.has(scope)) {
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
