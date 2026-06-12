import type { Request, Response } from "express"
import { z } from "zod"
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
})

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
     */
    async sendTest(req: Request, res: Response) {
      if (!pushService.isEnabled()) {
        throw new HttpError("Push notifications are not enabled", { status: 503, code: "PUSH_DISABLED" })
      }
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const { attempted, failed } = await pushService.deliverTestPush(workspaceId, userId)
      res.json({ attempted, failed, delivered: attempted - failed })
    },
  }
}
