import type { Socket, ExtendedError } from "socket.io"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import type { BotApiKeyService, ValidatedBotApiKey } from "../public-api"

/**
 * Auth middleware for the `/bot` Socket.IO namespace. Bot runtimes connect
 * with their `threa_bk_*` API key in `socket.handshake.auth.token` — the
 * same scope (`BOT_RUNTIME_WRITE`) that protects the HTTP runtime endpoints.
 *
 * On success it stamps the validated key onto `socket.data.bot` so the
 * connection handler can fan out into bot/instance rooms without re-reading
 * the key on every event.
 */
export interface BotSocketData {
  keyId: string
  workspaceId: string
  botId: string
  keyName: string
  scopes: Set<string>
}

export function createBotSocketAuthMiddleware(botApiKeyService: BotApiKeyService) {
  return async (socket: Socket, next: (err?: ExtendedError) => void): Promise<void> => {
    const token = readSocketToken(socket)
    if (!token) {
      next(new Error("Missing bot API key"))
      return
    }

    let validated: ValidatedBotApiKey | null
    try {
      validated = await botApiKeyService.validateKey(token)
    } catch {
      // `validateKey` only reaches the DB on prefix match; any thrown error here
      // is an infra failure, not a bad credential — fail closed regardless.
      next(new Error("Authentication failed"))
      return
    }

    if (!validated) {
      next(new Error("Invalid bot API key"))
      return
    }

    if (!validated.scopes.has(WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE)) {
      next(new Error("Bot API key missing BOT_RUNTIME_WRITE scope"))
      return
    }

    const data: BotSocketData = {
      keyId: validated.id,
      workspaceId: validated.workspaceId,
      botId: validated.botId,
      keyName: validated.name,
      scopes: validated.scopes,
    }
    socket.data.bot = data
    next()
  }
}

/**
 * Reads the bot API key from a Socket.IO handshake. Tried in order:
 *  1. `socket.handshake.auth.token` — the standard Socket.IO client path
 *  2. `Authorization: Bearer …` — for embedded clients that can only set
 *     `extraHeaders`, not the `auth` payload
 *
 * Exported so the namespace handler can re-validate the same token on a
 * periodic ticker without stashing it on `socket.data` (one fewer copy of
 * the secret living past the auth handshake).
 */
export function readSocketToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined
  const fromAuth = auth?.token
  if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth

  // Allow `Authorization: Bearer ...` for clients that can't set custom auth
  // payloads (rare — most Socket.IO clients use `auth`, but some embedded
  // runtimes only expose extraHeaders).
  const header = socket.handshake.headers.authorization
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim()
    return token.length > 0 ? token : null
  }
  return null
}
