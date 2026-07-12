import type { NextFunction, Request, Response } from "express"
import type { OperationId } from "../features/public-api/routes"
import * as versions from "../features/public-api/versions"
import type { ApiVersion } from "../features/public-api/versions"
import { publicApiVersionRequests } from "../lib/observability/metrics"

declare global {
  namespace Express {
    interface Request {
      /** Resolved public API wire version for this request (header override > key pin). */
      apiVersion?: ApiVersion
    }
  }
}

/**
 * Version context stashed on res.locals for the pino-http customProps hook in
 * app.ts. `apiVersion` is the raw requested value, not the parsed ApiVersion,
 * so a rejected `Threa-Version` header still logs what the caller sent.
 */
export interface ApiVersionLog {
  apiVersion: string
  versionSource: "header" | "key"
  keyId: string | null
  operationId: OperationId
}

/**
 * Resolves the request's public API version (header override beats the key's
 * pin), echoes it in the response `Threa-Version` header, and — when the caller
 * is behind on breaking changes — upgrades the request oldest→newest before the
 * handler's Zod validation and downgrades the response newest→oldest via a
 * `res.json` wrap. In the Phase-1 steady state (`VERSION_CHANGES` empty) this is
 * a pure pass-through that only sets `req.apiVersion` and the echo header.
 *
 * Mounted per-route by the registry loop, after publicApiAuth (needs the
 * validated key for the pin) and before the scope check + handler.
 */
export function createApiVersionGate(operationId: OperationId) {
  return function apiVersionGate(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("Threa-Version")
    const pinned = req.userApiKey?.apiVersion ?? req.botApiKey?.apiVersion ?? versions.CURRENT_API_VERSION

    // Stashed BEFORE parsing so the INVALID_API_VERSION 400 log still carries
    // the offending header value and key context.
    const log: ApiVersionLog = {
      apiVersion: header ?? pinned,
      versionSource: header ? "header" : "key",
      keyId: req.userApiKey?.id ?? req.botApiKey?.id ?? null,
      operationId,
    }
    res.locals.apiVersionLog = log

    // parseApiVersion throws HttpError(400 INVALID_API_VERSION) on an unknown
    // header; Express forwards the synchronous throw to the error handler.
    const version = header ? versions.parseApiVersion(header) : pinned

    req.apiVersion = version
    res.setHeader("Threa-Version", version)
    publicApiVersionRequests.inc({ version, source: log.versionSource })

    const pending = versions.changesAfter(version).filter((c) => c.operations.has(operationId))
    if (pending.length === 0) return next()

    for (const change of pending) {
      if (change.upgradeRequest) req.body = change.upgradeRequest(req.body, { operationId })
    }

    const json = res.json.bind(res)
    res.json = (payload: unknown) => {
      let out = payload
      for (let i = pending.length - 1; i >= 0; i--) {
        const change = pending[i]
        if (change.downgradeResponse) out = change.downgradeResponse(out, { operationId })
      }
      return json(out)
    }
    next()
  }
}
