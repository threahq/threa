import type { NextFunction, Request, RequestHandler, Response } from "express"
import type { Pool } from "pg"
import { BotRepository, type Bot } from "../features/public-api/bot-repository"
import { BotTypes, permissionsForRole, WORKSPACE_PERMISSION_SCOPES, type WorkspacePermissionSlug } from "@threa/types"
import { HttpError } from "@threa/backend-common"

const unauthenticated = () => new HttpError("Not authenticated", { status: 401, code: "UNAUTHENTICATED" })
const insufficient = () => new HttpError("Insufficient permissions", { status: 403, code: "FORBIDDEN" })

declare global {
  namespace Express {
    interface Request {
      bot?: Bot
    }
  }
}

/**
 * Prefers the local DB user (req.user.id) over the WorkOS user ID
 * (req.authUser.id) — bot.ownerUserId stores the local DB user ID.
 */
function resolveActorId(req: Request): string | null {
  return req.user?.id ?? req.authUser?.id ?? req.userApiKey?.userId ?? null
}

export function createRequireBotManagement(pool: Pool) {
  return function requireBotManagement(): RequestHandler {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      try {
        const workspaceId = req.workspaceId
        const id = req.params.botId
        if (!workspaceId || !id) {
          next(unauthenticated())
          return
        }

        const bot = await BotRepository.findById(pool, workspaceId, id)
        if (!bot) {
          next(new HttpError("Bot not found", { status: 404, code: "NOT_FOUND" }))
          return
        }

        if (bot.type === BotTypes.PERSONAL) {
          // Personal bots: ownership-based access. The owner can always manage
          // their bot regardless of workspace permission configuration.
          const actorId = resolveActorId(req) ?? req.botApiKey?.botId ?? null
          if (actorId !== bot.ownerUserId) {
            next(new HttpError("Forbidden", { status: 403, code: "FORBIDDEN" }))
            return
          }
        } else {
          // Shared bots: require bots:manage. Use the same resolution order as
          // requireWorkspacePermission — session JWT, role fallback, API key.
          const hasManage =
            req.authUser?.permissions?.includes(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE) ??
            (req.user != null &&
              (permissionsForRole(req.user.role) as readonly string[]).includes(
                WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE
              )) ??
            req.userApiKey?.scopes.has(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE) ??
            req.botApiKey?.scopes.has(WORKSPACE_PERMISSION_SCOPES.BOTS_MANAGE) ??
            false
          if (!hasManage) {
            next(insufficient())
            return
          }
        }

        req.bot = bot
        next()
      } catch (err) {
        next(err)
      }
    }
  }
}
