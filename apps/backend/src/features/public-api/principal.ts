import type { Request } from "express"
import { HttpError } from "../../lib/errors"
import type { StreamWritePrincipal } from "../streams"

/** Who a key acts as on a stream: a user key is its owner, a workspace key is the bot. */
export function apiKeyPrincipal(req: Request): StreamWritePrincipal {
  if (req.userApiKey) return { kind: "user", userId: req.user!.id }
  if (req.botApiKey) return { kind: "bot", botId: req.botApiKey.botId }
  throw new HttpError("No API key context", { status: 401, code: "UNAUTHORIZED" })
}
