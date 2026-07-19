import type { Express, Request, RequestHandler, Response } from "express"
import type { AccessLogService } from "./service"
import type { AccessKind, AccessLogOperation, AccessOutcome, ActorType } from "./operations"
import { readAuditSubjects } from "./subjects"

/**
 * The marker a route's audit middleware carries so the boot-time coverage guard
 * can read it off the router stack. A real annotation names an `operation` and
 * `kind`; a `kind: "none"` annotation exempts a route with a justification.
 */
export type AuditAnnotation = { operation: AccessLogOperation; kind: AccessKind } | { kind: "none"; reason: string }

interface AnnotatedHandler extends RequestHandler {
  auditAnnotation?: AuditAnnotation
}

/** The `audit(operation, kind)` factory with a `.none(reason)` exemption path. */
export interface AuditFactory {
  (operation: AccessLogOperation, kind: AccessKind): RequestHandler
  none(reason: string): RequestHandler
  /**
   * Denial backstop mounted BEFORE later auth/permission middleware (inside
   * `authed`, ahead of `workspaceUser`; in the public-API chain ahead of key
   * auth). Middleware that short-circuits with `res.status().json()` never
   * reaches the route's `audit(...)` handler, so without this a cross-workspace
   * probe or bad-API-key attempt would leave no forensic trace. Records only
   * denials, and only when no route-level audit hook ran.
   */
  boundary: RequestHandler
}

interface Identity {
  actorType: ActorType
  actorId: string
  authRef: string | null
}

function resolveIdentity(req: Request): Identity | null {
  if (req.botApiKey) {
    return { actorType: "bot", actorId: req.botApiKey.botId, authRef: req.botApiKey.id }
  }
  if (req.userApiKey) {
    return { actorType: "user", actorId: req.userApiKey.userId, authRef: req.userApiKey.id }
  }
  if (req.user) {
    return { actorType: "user", actorId: req.user.id, authRef: null }
  }
  // Workspace-less auth surface (/api/auth/me, /api/workspaces list/create, push
  // cleanup, integration callbacks) mounts `auth` alone — no workspaceUser, so
  // `req.user` is absent. Attribute to the WorkOS user id (workspace_id stays null).
  if (req.authUser) {
    return { actorType: "user", actorId: req.authUser.id, authRef: null }
  }
  return null
}

function outcomeFromStatus(status: number): AccessOutcome {
  if (status >= 500) return "error"
  // Every non-2xx/3xx below 500 is treated as `denied`: 401/403 and the
  // access-hiding 404 are the denial statuses this design targets, and
  // over-approximating other 4xx (400/409/429) as denied is the safe direction
  // for breach scoping (design §7.1 makes the same call for 404).
  if (status >= 400) return "denied"
  return "success"
}

/**
 * Fire `cb` exactly once when the response is done: 'finish' for a fully
 * written response, 'close' for an aborted one (client gone or stream torn
 * down mid-write). Data may already have egressed either way, so an aborted
 * response still gets a row rather than silently vanishing.
 */
function onResponseDone(res: Response, cb: (aborted: boolean) => void): void {
  let fired = false
  const fire = (aborted: boolean) => {
    if (fired) return
    fired = true
    cb(aborted)
  }
  res.on("finish", () => fire(false))
  res.on("close", () => fire(!res.writableFinished))
}

export function createAuditMiddleware(accessLogService: AccessLogService): AuditFactory {
  const audit = ((operation: AccessLogOperation, kind: AccessKind): RequestHandler => {
    const handler: AnnotatedHandler = (req, res, next) => {
      res.locals.auditHandled = true
      // Captured synchronously: Express restores `req.params` as the routing
      // stack unwinds, so it is not reliable inside the deferred hook.
      const routeWorkspaceId = req.params.workspaceId ?? null
      onResponseDone(res, (aborted) => {
        const identity = resolveIdentity(req)
        const outcome = aborted && !res.headersSent ? "error" : outcomeFromStatus(res.statusCode)

        // No identity at all: only denials are worth a row (attempted access to
        // an authed surface); successful unauthenticated hits are skipped.
        if (!identity && outcome !== "denied") return

        const workspaceId = req.workspaceId ?? routeWorkspaceId
        accessLogService.record({
          workspaceId,
          actorType: identity?.actorType ?? "user",
          actorId: identity?.actorId ?? "unknown",
          authRef: identity?.authRef ?? null,
          operation,
          accessKind: kind,
          outcome,
          subjects: readAuditSubjects(res) ?? null,
          detail: aborted ? { aborted: true } : null,
          ip: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: (req as Request & { id?: string }).id ?? null,
        })
      })
      next()
    }
    handler.auditAnnotation = { operation, kind }
    return handler
  }) as AuditFactory

  audit.none = (reason: string): RequestHandler => {
    const handler: AnnotatedHandler = (_req, res, next) => {
      res.locals.auditHandled = true
      next()
    }
    handler.auditAnnotation = { kind: "none", reason }
    return handler
  }

  audit.boundary = (req, res, next) => {
    const routeWorkspaceId = req.params.workspaceId ?? null
    onResponseDone(res, (aborted) => {
      // A route-level audit(...) ran — it owns the row.
      if (res.locals.auditHandled) return
      const outcome = aborted && !res.headersSent ? "error" : outcomeFromStatus(res.statusCode)
      if (outcome !== "denied") return

      const identity = resolveIdentity(req)
      const workspaceId = req.workspaceId ?? routeWorkspaceId
      accessLogService.record({
        workspaceId,
        actorType: identity?.actorType ?? "user",
        actorId: identity?.actorId ?? "unknown",
        authRef: identity?.authRef ?? null,
        operation: "auth.boundary_denied",
        accessKind: req.method === "GET" ? "read" : "write",
        outcome,
        subjects: workspaceId ? [{ type: "workspace", id: workspaceId }] : null,
        detail: aborted ? { aborted: true } : null,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: (req as Request & { id?: string }).id ?? null,
      })
    })
    next()
  }

  return audit
}

interface RouteLayer {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: { handle?: AnnotatedHandler }[]
  }
}

/**
 * Boot-time guard: every `/api` route must carry an audit annotation somewhere
 * in its handler chain (a real `audit(...)` or an `audit.none(...)` exemption).
 * Walks the Express 5 router stack (`app.router.stack`) and throws listing any
 * offending method+path, so a new route can't silently skip access logging.
 */
export function assertAuditCoverage(app: Express): void {
  const router = (app as unknown as { router?: { stack: RouteLayer[] } }).router
  if (!router) throw new Error("assertAuditCoverage: Express router stack not found (app.router missing)")

  const missing: string[] = []
  for (const layer of router.stack) {
    const route = layer.route
    if (!route) {
      // A sub-router mounted under /api would carry routes this walk cannot
      // see — the exact silent-decay path the guard exists to prevent. No
      // sub-router exists today; mounting one requires extending this guard
      // to recurse into it first.
      const l = layer as unknown as { name?: string }
      // Express 5 exposes a mounted router's path only as matcher closures, so
      // the guard cannot tell an /api mount from any other — and a router's
      // routes are invisible to this walk either way. No router mounts exist
      // today; any future one must extend this guard to recurse before it can
      // boot. Strictness is the point: routes must never silently escape audit.
      if (l.name === "router") {
        missing.push("(mounted sub-router — guard cannot see its routes; extend assertAuditCoverage to recurse)")
      }
      continue
    }
    if (!route.path.startsWith("/api")) continue
    const annotated = route.stack.some((s) => s.handle?.auditAnnotation != null)
    if (annotated) continue
    const methods = Object.keys(route.methods)
      .filter((m) => route.methods[m])
      .map((m) => m.toUpperCase())
      .join(",")
    missing.push(`${methods || "?"} ${route.path}`)
  }

  if (missing.length > 0) {
    throw new Error(
      `access-log coverage: ${missing.length} /api route(s) missing an audit annotation:\n  ${missing.join("\n  ")}`
    )
  }
}
