import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express"
import { z } from "zod"
import { PUSH_RECEIPT_STAGES, PUSH_RECEIPT_SUPPRESSION_REASONS, PUSH_RECEIPT_TOKEN_PATTERN } from "@threahq/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import type { PushService } from "./service"

/**
 * Validate that a push endpoint URL is HTTPS and not targeting a private/loopback address.
 * Web Push endpoints are always HTTPS URLs from browser push services (FCM, Mozilla, etc.).
 */
const pushEndpointSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== "https:") return false
        const host = parsed.hostname
        // Reject loopback, private IP ranges, and link-local addresses (IPv4 + IPv6)
        // URL.hostname retains brackets for IPv6: new URL("https://[::1]/").hostname → "[::1]"
        if (host === "localhost" || /^127\./.test(host) || host === "[::1]" || host === "[::]") return false
        if (host.startsWith("10.")) return false
        if (host.startsWith("192.168.")) return false
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false
        if (host.startsWith("169.254.")) return false
        if (host.startsWith("0.")) return false
        // IPv6 private ranges: IPv4-mapped (::ffff:), unique local (fc/fd), link-local (fe80)
        const hostLower = host.toLowerCase()
        if (hostLower.startsWith("[::ffff:")) return false
        if (hostLower.startsWith("[fc") || hostLower.startsWith("[fd")) return false
        if (hostLower.startsWith("[fe80")) return false
        return true
      } catch {
        return false
      }
    },
    { message: "Push endpoint must be an HTTPS URL and must not target a private network address" }
  )

const subscribeSchema = z.object({
  endpoint: pushEndpointSchema,
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  deviceKey: z.string().min(1),
  userAgent: z.string().optional(),
  /** The active service worker's receipt protocol; absent from old frontends and old workers. */
  receiptVersion: z.number().int().min(1).max(1_000).optional(),
})

const receiptSchema = z
  .object({
    token: z.string().regex(PUSH_RECEIPT_TOKEN_PATTERN),
    stage: z.enum(PUSH_RECEIPT_STAGES),
    reason: z.enum(PUSH_RECEIPT_SUPPRESSION_REASONS).optional(),
  })
  .strict()

const receiptParamsSchema = z.object({ workspaceId: z.string().min(1).max(64) })

const testProgressParamsSchema = z.object({ testId: z.string().min(1).max(64) })

/**
 * The token-only receipt route, matched on `req.path` in any letter case, as
 * Express routes it (an absolute-form request target included). The app-wide
 * 10mb parser skips it; {@link pushReceiptBodyParser} runs instead.
 */
const PUSH_RECEIPT_PATH = /^\/api\/workspaces\/[^/]+\/push\/receipts\/?$/i

export function isPushReceiptPath(path: string): boolean {
  return PUSH_RECEIPT_PATH.test(path)
}

/**
 * A receipt path whose workspace segment is a canonical id, so Express always
 * decodes it and routes to the receipt limiter. Only this may skip the global
 * baseline: an undecodable segment (`%zz`) fails before any route runs.
 */
const ROUTABLE_PUSH_RECEIPT_PATH = /^\/api\/workspaces\/[A-Za-z0-9_-]{1,64}\/push\/receipts\/?$/i

export function isRoutablePushReceiptPath(path: string): boolean {
  return ROUTABLE_PUSH_RECEIPT_PATH.test(path)
}

/** A receipt body is a token and two enum values, far under this. */
const PUSH_RECEIPT_BODY_LIMIT = "1kb"

export const pushReceiptBodyParser: RequestHandler = express.json({ limit: PUSH_RECEIPT_BODY_LIMIT, type: () => true })

/**
 * Body-parser failures become plain HttpErrors here: the shared error
 * handler would otherwise log and report the parser error, and a
 * malformed-JSON error carries the raw body (the capability token) with it.
 * Every body-parser error carries a string `type` and a 4xx `status`
 * (entity.*, charset/encoding unsupported, request aborted or mis-sized).
 */
export const pushReceiptErrors: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  _res: Response,
  next: NextFunction
) => {
  const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown }
  if (typeof type !== "string" || typeof status !== "number" || status < 400 || status >= 500) return next(err)
  if (type === "entity.too.large") {
    return next(new HttpError("Receipt body too large", { status: 413, code: "PAYLOAD_TOO_LARGE" }))
  }
  next(new HttpError("Receipt body is not valid JSON", { status: 400, code: "INVALID_PAYLOAD" }))
}

const unsubscribeSchema = z.object({
  endpoint: pushEndpointSchema,
})

interface Dependencies {
  pushService: PushService
}

export function createPushHandlers({ pushService }: Dependencies) {
  return {
    async subscribe(req: Request, res: Response) {
      if (!pushService.isEnabled()) {
        throw new HttpError("Push notifications are not enabled", { status: 503, code: "PUSH_DISABLED" })
      }
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const data = validateRequest(subscribeSchema, req.body)

      const subscription = await pushService.subscribe({
        workspaceId,
        userId,
        ...data,
      })

      res.json({ subscription: { id: subscription.id } })
    },

    async unsubscribe(req: Request, res: Response) {
      if (!pushService.isEnabled()) {
        throw new HttpError("Push notifications are not enabled", { status: 503, code: "PUSH_DISABLED" })
      }
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { endpoint } = validateRequest(unsubscribeSchema, req.body)

      await pushService.unsubscribe(workspaceId, userId, endpoint)
      res.json({ ok: true })
    },

    /**
     * Clean up all push subscriptions matching an endpoint across all workspaces.
     * Called during logout before the browser-side unsubscribe to prevent stale records.
     * Not workspace-scoped — uses auth-only middleware.
     */
    async cleanupEndpoint(req: Request, res: Response) {
      const { endpoint } = validateRequest(unsubscribeSchema, req.body)

      await pushService.unsubscribeAllWorkspaces(endpoint, req.workosUserId!)
      res.json({ ok: true })
    },

    /**
     * A service worker's receipt. No session: the token in the body is the
     * credential, scoped to this workspace. Always 204 for a well-formed body,
     * whatever the token matched, so it answers nothing about tokens.
     */
    async recordReceipt(req: Request, res: Response) {
      const { workspaceId } = validateRequest(receiptParamsSchema, req.params)
      const body = validateRequest(receiptSchema, req.body)
      await pushService.recordReceipt({
        workspaceId,
        token: body.token,
        stage: body.stage,
        reason: body.reason ?? null,
      })
      res.status(204).end()
    },

    /** Poll the caller's own Send test for per-device receipts. */
    async getTestProgress(req: Request, res: Response) {
      const { testId } = validateRequest(testProgressParamsSchema, req.params)
      res.json(await pushService.getTestProgress(req.workspaceId!, req.user!.id, testId))
    },

    async getVapidKey(_req: Request, res: Response) {
      res.json({
        vapidPublicKey: pushService.getVapidPublicKey() || null,
        enabled: pushService.isEnabled(),
      })
    },

    /**
     * Send a real push notification to all of the caller's devices in this
     * workspace. Used by the in-app "Send test" diagnostic so the user can
     * verify the full delivery loop, not just the local SW notification path.
     * The response keeps `attempted`/`failed`/`delivered` for cached PWA
     * bundles that predate per-device results.
     */
    async sendTest(req: Request, res: Response) {
      if (!pushService.isEnabled()) {
        throw new HttpError("Push notifications are not enabled", { status: 503, code: "PUSH_DISABLED" })
      }
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      res.json(await pushService.deliverTestPush(workspaceId, userId))
    },
  }
}
