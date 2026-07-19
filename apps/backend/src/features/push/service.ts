import type { Pool } from "pg"
import webpush from "web-push"
import { withTransaction, withClient } from "../../db"
import { PushSubscriptionRepository, type PushSubscription, type InsertPushSubscriptionParams } from "./repository"
import { UserSessionRepository, type UserSession } from "./session-repository"
import {
  PrefNotificationLevels,
  ActivityTypes,
  StreamTypes,
  PRESENCE_INTERACTION_WINDOW_MS,
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  ENCRYPTED_MESSAGE_PREVIEW_LABEL,
  stripMarkdownToInline,
  type PrefNotificationLevel,
  type StreamType,
} from "@threa/types"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import type {
  ActivityCreatedOutboxPayload,
  SavedReminderFiredOutboxPayload,
  EnclaveRewrapNudgeOutboxPayload,
  CallInvitationCreatedOutboxPayload,
  CallInvitationSettledOutboxPayload,
} from "../../lib/outbox"

/** Maximum push subscriptions per user per workspace to bound parallel delivery calls */
const MAX_SUBSCRIPTIONS_PER_USER = 10

/**
 * Hard cap on each web-push HTTP request. Without it the web-push library sets
 * no socket timeout at all, so a push-service connection that accepts TLS but
 * never responds blocks indefinitely (Node enables no TCP keepalive here) —
 * and because the outbox handler processes events sequentially under a held
 * cursor lock, one hung send wedges ALL push delivery for every user until
 * the process restarts.
 */
const WEBPUSH_TIMEOUT_MS = 10_000

/**
 * How long the push service may queue a message push for an offline device.
 * Bounded so a device reconnecting after days doesn't replay a backlog of
 * stale alerts (the web-push default is 28 days).
 */
const MESSAGE_PUSH_TTL_SECONDS = 24 * 60 * 60

/** Session-expired is not time-critical but should eventually land. */
const SESSION_EXPIRED_TTL_SECONDS = 7 * 24 * 60 * 60

/** A test push is only meaningful while the user is watching for it. */
const TEST_PUSH_TTL_SECONDS = 60

/**
 * A ring is only worth delivering while it's still ringing. Bounded to the
 * invitation TTL so a device that reconnects after the ring lapsed never wakes
 * to a call that already went to the missed-call feed. The matching cancel push
 * rides the same topic to collapse an undelivered ring.
 */
const CALL_RING_TTL_SECONDS = 45

/**
 * Delivery class for a push send. `urgency: "high"` wakes a dozing Android
 * device — with the default "normal" FCM/autopush batch delivery until the
 * next Doze maintenance window and a real-time message lands minutes-to-hours
 * late. `topic` makes the push service collapse queued same-topic pushes to
 * the newest one, so an offline device gets one alert per stream on reconnect
 * instead of a buzz per message.
 */
interface PushDeliveryOptions {
  ttlSeconds: number
  urgency: "very-low" | "low" | "normal" | "high"
  /** Must be ≤32 base64url characters (push-service constraint) — see pushTopic. */
  topic?: string
}

/**
 * Collapse key for the push service, from a prefixed ULID. The Web Push Topic
 * header allows at most 32 base64url chars, so a 33-char id like
 * `stream_01ABC…` can't be used verbatim — the 26-char ULID plus a short kind
 * suffix (to keep e.g. mention pushes from collapsing into message pushes for
 * the same stream) stays within the limit.
 */
function pushTopic(prefixedId: string, kindSuffix = ""): string {
  return prefixedId.slice(prefixedId.indexOf("_") + 1) + kindSuffix
}

/** How recently a device must have sent a heartbeat to be considered "active" */
const ACTIVE_SESSION_WINDOW_MS = 60_000

/**
 * How recently `last_focused_at` must have been bumped for us to treat the
 * device as currently focused. Heartbeats fire every 30s while focused (and
 * immediately on focus change), so a 60s window catches the focused state with
 * at most one heartbeat of lag.
 */
const CURRENTLY_FOCUSED_WINDOW_MS = 60_000

/**
 * How recently the device must have seen a real user interaction
 * (pointerdown/keydown/touchstart) to count as "the device the user is on".
 * A focused-but-untouched window (e.g. PWA open in another desktop space)
 * shouldn't claim the user's attention indefinitely — without interaction we
 * fall through to fanout so the user gets notified on whichever device they
 * pick up next.
 */
// Shared with the frontend SW's push-suppression check so the two layers agree
// on what "present" means (@threa/types).
const RECENT_INTERACTION_WINDOW_MS = PRESENCE_INTERACTION_WINDOW_MS

/**
 * Per-device session expiry window. If a specific device has not sent a heartbeat
 * within this window, its auth session has likely expired. We send a "session expired"
 * push to that device and clean up its subscription individually — other devices with
 * active sessions are unaffected. Matches the 30-day session cookie TTL and the
 * session GC window in session-cleanup.ts.
 */
const SESSION_EXPIRY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000 // 30 days (matches cookie TTL)

/** Callbacks for resolving cross-feature data (INV-52: access via service layer, not repos) */
interface CrossFeatureLookups {
  /** Resolve a user's notification level preference. */
  getUserNotificationLevel: (workspaceId: string, userId: string) => Promise<PrefNotificationLevel>
  /**
   * Whether the user currently has notifications paused (do-not-disturb) — via
   * a do-not-disturb status or a manual pause. Evaluated at delivery time so an
   * expired pause stops suppressing even while the user is offline.
   */
  isNotificationPaused: (workspaceId: string, userId: string) => Promise<boolean>
  /** Resolve a stream's type by ID within a workspace. Returns null if not found. */
  getStreamType: (workspaceId: string, streamId: string) => Promise<StreamType | null>
  /**
   * Resolve the workspace-scoped user's global WorkOS user id. Stamped on the
   * push payload so the recipient device can flip to the right signed-in
   * account before opening the deep link. Returns null if the user is not found.
   */
  getWorkosUserId: (workspaceId: string, userId: string) => Promise<string | null>
}

interface PushServiceDeps {
  pool: Pool
  vapidConfig: {
    publicKey: string
    privateKey: string
    subject: string
  } | null
  lookups: CrossFeatureLookups
}

/**
 * Resolve the `contentPreview` for a saved-reminder push. E2E messages store a
 * zero-width placeholder on the wire (the server holds no key), so surfacing
 * the raw markdown produces a blank notification — substitute a generic,
 * leak-free label instead (E2EE-19), mirroring the saved-list/sidebar
 * treatment. Normal messages are stripped to plain text before truncation so
 * the OS notification never shows literal markdown syntax (INV-60 — the SW
 * renders this verbatim, there is no later strip step). Missing content → null.
 */
export function resolveSavedReminderPreview(contentMarkdown: string | null | undefined): string | null {
  if (contentMarkdown === E2E_PLACEHOLDER_CONTENT_MARKDOWN) return ENCRYPTED_MESSAGE_PREVIEW_LABEL
  if (contentMarkdown == null) return null
  return stripMarkdownToInline(contentMarkdown).slice(0, 200)
}

/**
 * Classify a webpush send failure. 404/410 mean the endpoint is gone — evict.
 * 401/403 are never per-device: the push service rejected our VAPID auth, so
 * every future send to that service fails identically — logged at error level
 * (INV-11: a misconfig must be an alarm, not a warn-line in the noise).
 */
function classifySendFailure(err: unknown, subscriptionId: string): "stale" | "other" {
  const statusCode = (err as { statusCode?: number }).statusCode
  if (statusCode === 404 || statusCode === 410) {
    logger.info({ subscriptionId, statusCode }, "Marking stale push subscription for removal")
    return "stale"
  }
  if (statusCode === 401 || statusCode === 403) {
    logger.error(
      { err, subscriptionId, statusCode },
      "Push service rejected VAPID auth — delivery to this push service is broken until VAPID config is fixed"
    )
    return "other"
  }
  logger.warn({ err, subscriptionId }, "Failed to send push notification")
  return "other"
}

export class PushService {
  private readonly pool: Pool
  private readonly vapidPublicKey: string
  private readonly canSend: boolean
  private readonly lookups: CrossFeatureLookups

  constructor(deps: PushServiceDeps) {
    this.pool = deps.pool
    this.lookups = deps.lookups

    if (deps.vapidConfig) {
      // INV-9 approved exception: web-push requires module-level VAPID config (same class as
      // Langfuse/OTEL — external library bootstrap constraint). Only one PushService per process.
      webpush.setVapidDetails(deps.vapidConfig.subject, deps.vapidConfig.publicKey, deps.vapidConfig.privateKey)
      this.vapidPublicKey = deps.vapidConfig.publicKey
      this.canSend = true
    } else {
      this.vapidPublicKey = ""
      this.canSend = false
    }
  }

  isEnabled(): boolean {
    return this.canSend
  }

  getVapidPublicKey(): string {
    return this.vapidPublicKey
  }

  async subscribe(params: InsertPushSubscriptionParams): Promise<PushSubscription> {
    // Atomic cap enforcement (INV-20): count + evict + insert in one transaction.
    // The FOR UPDATE lock serializes concurrent subscribe calls for the same user.
    // Existence check runs after locking to prevent double-eviction races.
    return withTransaction(this.pool, async (client) => {
      const count = await PushSubscriptionRepository.countByUserForUpdate(client, params.workspaceId, params.userId)
      if (count >= MAX_SUBSCRIPTIONS_PER_USER) {
        const isReRegister = await PushSubscriptionRepository.existsByEndpoint(
          client,
          params.workspaceId,
          params.userId,
          params.endpoint
        )
        if (!isReRegister) {
          await PushSubscriptionRepository.deleteOldestByUser(client, params.workspaceId, params.userId)
        }
      }
      return PushSubscriptionRepository.insert(client, params)
    })
  }

  async unsubscribe(workspaceId: string, userId: string, endpoint: string): Promise<boolean> {
    return PushSubscriptionRepository.deleteByEndpoint(this.pool, workspaceId, userId, endpoint)
  }

  /** Remove all push subscriptions for a browser endpoint across all workspaces (used on logout). */
  async unsubscribeAllWorkspaces(endpoint: string, workosUserId: string): Promise<number> {
    return PushSubscriptionRepository.deleteByEndpointForUser(this.pool, endpoint, workosUserId)
  }

  /**
   * Sends a server-driven test push to all of the user's subscriptions in the
   * workspace. Bypasses the focus-suppression and notification-preference logic
   * because this is an explicit user diagnostic — we want to know whether the
   * full delivery loop (DB → web-push → device) is working.
   *
   * Returns delivery stats so the caller can show "delivered to N devices" or
   * "all N devices failed". Stale endpoints (404/410) are evicted so the next
   * test reflects current registration state.
   */
  async deliverTestPush(workspaceId: string, userId: string): Promise<{ attempted: number; failed: number }> {
    if (!this.canSend) {
      // Mirror handlers.ts contract (INV-32) so non-handler callers (workers,
      // internal APIs) get the same status/code semantics instead of a generic
      // 500 from a plain Error bubbling through the error middleware.
      throw new HttpError("Push notifications are not enabled", { status: 503, code: "PUSH_DISABLED" })
    }

    const subscriptions = await PushSubscriptionRepository.findByUserId(this.pool, workspaceId, userId)
    if (subscriptions.length === 0) {
      return { attempted: 0, failed: 0 }
    }

    const pushPayload = JSON.stringify({
      data: {
        kind: "test" as const,
        workspaceId,
        sentAt: Date.now(),
      },
    })

    let failed = 0
    const staleIds: string[] = []
    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            pushPayload,
            { timeout: WEBPUSH_TIMEOUT_MS, TTL: TEST_PUSH_TTL_SECONDS, urgency: "high" }
          )
        } catch (err: unknown) {
          failed++
          if (classifySendFailure(err, sub.id) === "stale") {
            staleIds.push(sub.id)
          }
        }
      })
    )

    if (staleIds.length > 0) {
      try {
        await PushSubscriptionRepository.deleteByIds(this.pool, workspaceId, staleIds)
      } catch (deleteErr) {
        logger.warn({ err: deleteErr, count: staleIds.length }, "Failed to delete stale subscriptions after test push")
      }
    }

    return { attempted: subscriptions.length, failed }
  }

  async upsertSession(params: {
    workspaceId: string
    userId: string
    deviceKey: string
    focused?: boolean
    interacted?: boolean
  }): Promise<UserSession> {
    return UserSessionRepository.upsert(this.pool, params)
  }

  async upsertSessionsBatch(
    entries: Array<{ workspaceId: string; userId: string; deviceKey: string }>,
    options?: { focused?: boolean; interacted?: boolean }
  ): Promise<void> {
    return UserSessionRepository.upsertBatch(this.pool, entries, options)
  }

  /**
   * Delete user sessions that haven't sent a heartbeat within the retention window.
   * Cross-workspace by design (INV-8 infra exception): user_sessions is ephemeral
   * delivery-infrastructure data (heartbeat timestamps for push suppression), not
   * user-facing product data. Scoping cleanup per-workspace would require iterating
   * all workspaces for a simple time-based GC — same pattern as orphan session cleanup.
   */
  async cleanupStaleSessions(olderThanMs: number): Promise<number> {
    return UserSessionRepository.cleanupStale(this.pool, olderThanMs)
  }

  /**
   * Core delivery method: evaluates an activity:created event and sends push
   * notifications to the target user's eligible devices.
   *
   * Sends structured data in the push payload (INV-46); the service worker
   * formats display text client-side.
   */
  async deliverPushForActivity(payload: ActivityCreatedOutboxPayload): Promise<void> {
    if (!this.canSend) return

    const { workspaceId, targetUserId, activity } = payload

    // Self rows represent the target user's own action — do not push.
    if (activity.isSelf) return

    // Member-added activities notify via the feed only, not push.
    if (activity.activityType === ActivityTypes.MEMBER_ADDED) return

    const prefLevel = await this.lookups.getUserNotificationLevel(workspaceId, targetUserId)

    if (prefLevel === PrefNotificationLevels.NONE) {
      return
    }

    // Do-not-disturb suppresses push delivery (the activity feed already
    // recorded the row — DND silences the alert, it does not drop history).
    if (await this.lookups.isNotificationPaused(workspaceId, targetUserId)) {
      return
    }

    if (prefLevel === PrefNotificationLevels.MENTIONS) {
      const shouldPush = await this.shouldPushForMentionsMode(workspaceId, activity.activityType, activity.streamId)
      if (!shouldPush) {
        return
      }
    }

    // Subscriptions on devices with an expired session get a one-shot "session expired"
    // notification and are cleaned up; active-device subscriptions get normal delivery.
    const { active: activeSubscriptions, expired: expiredSubscriptions } = await this.getTargetSubscriptions(
      workspaceId,
      targetUserId
    )

    if (expiredSubscriptions.length > 0) {
      await this.deliverSessionExpiredAndCleanup(workspaceId, targetUserId, expiredSubscriptions)
    }

    if (activeSubscriptions.length === 0) {
      return
    }

    // Recipient's global WorkOS user id — lets the SW flip the active account
    // before opening the deep link when this push is for a parked account.
    // Resolved after the no-subscriptions early-return so we never pay the
    // lookup for a delivery that won't happen.
    const recipientWorkosUserId = await this.lookups.getWorkosUserId(workspaceId, targetUserId)

    const context = activity.context as
      | { contentPreview?: string; streamName?: string; authorName?: string; emoji?: string; mode?: string }
      | null
      | undefined
    // A missed call renders with its own SW branch ("Missed call from …"): the
    // generic message-grouping path has no missed_call copy, so it would title
    // the banner "New message". The kind + mode route it to the dedicated branch.
    const isMissedCall = activity.activityType === ActivityTypes.MISSED_CALL
    const pushPayload = JSON.stringify({
      data: {
        ...(isMissedCall ? { kind: "missed_call" as const, mode: context?.mode } : {}),
        workspaceId,
        workosUserId: recipientWorkosUserId ?? undefined,
        streamId: activity.streamId,
        messageId: activity.messageId,
        activityType: activity.activityType,
        contentPreview: context?.contentPreview?.slice(0, 200),
        streamName: context?.streamName,
        authorName: context?.authorName,
        // Reaction emoji — lets the SW render "Alice reacted 👍 to …" instead of
        // formatting a reaction like a plain incoming message. Absent for non-reactions.
        emoji: context?.emoji,
      },
    })

    // Topic keyed by stream + notification group: mentions display under their
    // own tag in the SW, so they collapse separately from plain messages.
    const isMention = activity.activityType === ActivityTypes.MENTION
    await this.sendAndEvictStale(workspaceId, activeSubscriptions, pushPayload, {
      ttlSeconds: MESSAGE_PUSH_TTL_SECONDS,
      urgency: "high",
      topic: activity.streamId ? pushTopic(activity.streamId, isMention ? "m" : "") : undefined,
    })
  }

  /**
   * Deliver push for a saved-message reminder. Reminders respect the user's
   * global notification preference — a user with push disabled gets no
   * delivery even for a reminder they explicitly scheduled. (Sonner toast
   * still fires via socket delivery on online devices.)
   */
  async deliverPushForSavedReminder(payload: SavedReminderFiredOutboxPayload): Promise<void> {
    if (!this.canSend) return

    const { workspaceId, targetUserId, savedId, messageId, streamId, saved } = payload

    const prefLevel = await this.lookups.getUserNotificationLevel(workspaceId, targetUserId)
    if (prefLevel === PrefNotificationLevels.NONE) {
      return
    }

    // A reminder the user scheduled still respects an active do-not-disturb
    // window — the push is held back; the in-app/socket toast still fires.
    if (await this.lookups.isNotificationPaused(workspaceId, targetUserId)) {
      return
    }

    const { active: activeSubscriptions, expired: expiredSubscriptions } = await this.getTargetSubscriptions(
      workspaceId,
      targetUserId
    )

    if (expiredSubscriptions.length > 0) {
      await this.deliverSessionExpiredAndCleanup(workspaceId, targetUserId, expiredSubscriptions)
    }

    if (activeSubscriptions.length === 0) {
      return
    }

    // Structured payload (INV-46): the SW composes display text. When the
    // message is unavailable (deleted or access lost) we still notify — the
    // user set the reminder deliberately — but include the reason so the SW
    // can render "Reminder (message deleted)".
    const pushPayload = JSON.stringify({
      data: {
        kind: "saved_reminder",
        workspaceId,
        savedId,
        streamId,
        messageId,
        // When the message was saved from a conversation, the SW deep-links the
        // click into the conversation panel instead of the stream permalink.
        conversationId: saved.conversationId ?? undefined,
        streamName: saved.message?.streamName ?? null,
        // Standalone (message-less) items preview their own title.
        contentPreview: resolveSavedReminderPreview(saved.message?.contentMarkdown) ?? saved.title,
        unavailableReason: saved.unavailableReason ?? null,
      },
    })

    await this.sendAndEvictStale(workspaceId, activeSubscriptions, pushPayload, {
      ttlSeconds: MESSAGE_PUSH_TTL_SECONDS,
      urgency: "high",
      topic: pushTopic(savedId),
    })
  }

  /**
   * Deliver the offline owner's re-wrap nudge: an enclave turn in their E2E
   * scratchpad is stuck because no live agent instance holds the stream's key,
   * and only their unlocked device can re-wrap it. The graced web-push pulls
   * them back to the app, where the heal fires on open. Respects the global
   * notification preference and do-not-disturb like a saved reminder — an owner
   * who silenced push isn't woken; their next app open heals it regardless.
   * Focus-suppression (via `getTargetSubscriptions`) keeps it off a device the
   * owner is already looking at — there the socket signal already healed it.
   */
  async deliverRewrapNudge(payload: EnclaveRewrapNudgeOutboxPayload): Promise<void> {
    if (!this.canSend) return

    const { workspaceId, targetUserId, rootStreamId } = payload

    const prefLevel = await this.lookups.getUserNotificationLevel(workspaceId, targetUserId)
    if (prefLevel === PrefNotificationLevels.NONE) return
    if (await this.lookups.isNotificationPaused(workspaceId, targetUserId)) return

    const { active: activeSubscriptions, expired: expiredSubscriptions } = await this.getTargetSubscriptions(
      workspaceId,
      targetUserId
    )

    if (expiredSubscriptions.length > 0) {
      await this.deliverSessionExpiredAndCleanup(workspaceId, targetUserId, expiredSubscriptions)
    }

    if (activeSubscriptions.length === 0) return

    const recipientWorkosUserId = await this.lookups.getWorkosUserId(workspaceId, targetUserId)

    // Structured payload (INV-46): the service worker composes the display text.
    const pushPayload = JSON.stringify({
      data: {
        kind: "rewrap_needed",
        workspaceId,
        workosUserId: recipientWorkosUserId ?? undefined,
        streamId: rootStreamId,
      },
    })

    // "r" suffix keeps repeated nudges collapsing with each other, not with
    // message pushes for the same stream.
    await this.sendAndEvictStale(workspaceId, activeSubscriptions, pushPayload, {
      ttlSeconds: MESSAGE_PUSH_TTL_SECONDS,
      urgency: "high",
      topic: pushTopic(rootStreamId, "r"),
    })
  }

  /**
   * For "mentions" mode: push if activityType is "mention", or if the message
   * or reaction is from a DM or scratchpad (direct communication channels).
   *
   * Reactions follow the same semantics as messages (thread-activity tier,
   * not mention tier) — they push in direct channels, not in general channels.
   */
  private async shouldPushForMentionsMode(
    workspaceId: string,
    activityType: string,
    /** Null only for stream-less saved_reminder rows, which never reach the DM/scratchpad check below. */
    streamId: string | null
  ): Promise<boolean> {
    if (activityType === ActivityTypes.MENTION) {
      return true
    }

    // A missed call is direct communication like a DM message — it pushes in
    // mentions mode regardless of the host stream type.
    if (activityType === ActivityTypes.MISSED_CALL) {
      return true
    }

    if ((activityType === ActivityTypes.MESSAGE || activityType === ActivityTypes.REACTION) && streamId !== null) {
      const streamType = await this.lookups.getStreamType(workspaceId, streamId)
      if (streamType === StreamTypes.DM || streamType === StreamTypes.SCRATCHPAD) {
        return true
      }
    }

    return false
  }

  /**
   * Deliver the incoming-call ring push. High-urgency, short-TTL, topic-collapsed
   * on the attempt id so the matching cancel push supersedes an undelivered ring.
   * Respects the invitee's notification preference and do-not-disturb (NONE or
   * DND → no push; the in-app socket ring still fires, and the overlay is
   * quiet-able). Fans to the invitee's devices without the focus-suppression
   * of `getTargetSubscriptions` — a ring must reach a locked phone. Structured
   * payload (INV-46): the service worker composes the notification.
   */
  async deliverCallRing(payload: CallInvitationCreatedOutboxPayload): Promise<void> {
    if (!this.canSend) return
    const { workspaceId, targetUserId, attemptId, callId, streamId, inviter, mode, expiresAt } = payload

    const prefLevel = await this.lookups.getUserNotificationLevel(workspaceId, targetUserId)
    if (prefLevel === PrefNotificationLevels.NONE) return
    if (await this.lookups.isNotificationPaused(workspaceId, targetUserId)) return

    const subscriptions = await PushSubscriptionRepository.findByUserId(this.pool, workspaceId, targetUserId)
    if (subscriptions.length === 0) return

    const recipientWorkosUserId = await this.lookups.getWorkosUserId(workspaceId, targetUserId)
    const pushPayload = JSON.stringify({
      data: {
        kind: "call_ring",
        workspaceId,
        workosUserId: recipientWorkosUserId ?? undefined,
        attemptId,
        callId,
        streamId,
        inviterName: inviter.name ?? undefined,
        mode,
        expiresAt,
      },
    })

    await this.sendAndEvictStale(workspaceId, subscriptions, pushPayload, {
      ttlSeconds: CALL_RING_TTL_SECONDS,
      urgency: "high",
      topic: pushTopic(attemptId, "c"),
    })
  }

  /**
   * Cancel a ring push on every settle (accept/decline/cancel/expire). Same topic
   * as the ring so an undelivered ring queued for an offline device collapses to
   * this cancel; a delivered ring is closed by the service worker. No preference
   * gate — a cancel must always chase whatever ring might have gone out.
   */
  async deliverCallRingCancel(payload: CallInvitationSettledOutboxPayload): Promise<void> {
    if (!this.canSend) return
    const { workspaceId, targetUserId, attemptId } = payload

    const subscriptions = await PushSubscriptionRepository.findByUserId(this.pool, workspaceId, targetUserId)
    if (subscriptions.length === 0) return

    const pushPayload = JSON.stringify({
      data: { kind: "call_ring_cancel", workspaceId, attemptId },
    })

    await this.sendAndEvictStale(workspaceId, subscriptions, pushPayload, {
      ttlSeconds: CALL_RING_TTL_SECONDS,
      urgency: "high",
      topic: pushTopic(attemptId, "c"),
    })
  }

  /**
   * Sends a push payload to the given subscriptions and batch-deletes any
   * that return 404/410 (INV-56). Shared by all delivery paths (INV-35).
   *
   * Deliberately NO web-push "clear" fan-out exists here (it used to): a push
   * that results in no visible notification counts against browser silent-push
   * quotas — Firefox revokes the subscription outright when its quota hits 0,
   * iOS revokes after 3 — so notification-less pushes actively destroy the
   * registrations they ride on. Cross-device dismissal rides the socket
   * instead (workspace-sync posts SW_MSG_CLEAR_NOTIFICATIONS for open apps)
   * plus a bootstrap-time sweep for apps that were closed
   * (lib/notification-sweep.ts).
   */
  private async sendAndEvictStale(
    workspaceId: string,
    subscriptions: PushSubscription[],
    pushPayload: string,
    options: PushDeliveryOptions
  ): Promise<void> {
    const staleIds: string[] = []
    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            pushPayload,
            {
              timeout: WEBPUSH_TIMEOUT_MS,
              TTL: options.ttlSeconds,
              urgency: options.urgency,
              ...(options.topic ? { topic: options.topic } : {}),
            }
          )
        } catch (err: unknown) {
          if (classifySendFailure(err, sub.id) === "stale") {
            staleIds.push(sub.id)
          }
        }
      })
    )

    if (staleIds.length > 0) {
      try {
        await PushSubscriptionRepository.deleteByIds(this.pool, workspaceId, staleIds)
      } catch (deleteErr) {
        logger.warn({ err: deleteErr, count: staleIds.length }, "Failed to delete stale subscriptions")
      }
    }
  }

  /**
   * Sends a "session expired" push to the given devices and deletes their
   * subscriptions. Only targets devices whose sessions have expired — active
   * devices are unaffected. The SW shows a "Your session has expired — tap
   * to sign back in" notification.
   */
  private async deliverSessionExpiredAndCleanup(
    workspaceId: string,
    userId: string,
    subscriptions: PushSubscription[]
  ): Promise<void> {
    const pushPayload = JSON.stringify({
      data: {
        action: "session_expired" as const,
        workspaceId,
      },
    })

    // Best-effort delivery — some subscriptions may already be stale
    await this.sendAndEvictStale(workspaceId, subscriptions, pushPayload, {
      ttlSeconds: SESSION_EXPIRED_TTL_SECONDS,
      urgency: "normal",
      topic: "session-expired",
    })

    // Clean up remaining subscriptions so no further notifications are sent.
    // Reuse the IDs we already have rather than re-fetching (INV-20: avoids
    // select-then-delete race where a concurrent subscribe could be wiped).
    // deleteByIds is a no-op for IDs already removed by sendAndEvictStale.
    const subscriptionIds = subscriptions.map((s) => s.id)
    try {
      await PushSubscriptionRepository.deleteByIds(this.pool, workspaceId, subscriptionIds)
      logger.info(
        { workspaceId, userId, count: subscriptionIds.length },
        "Cleaned up push subscriptions for expired session"
      )
    } catch (err) {
      logger.warn({ err, workspaceId, userId }, "Failed to clean up push subscriptions for expired session")
    }
  }

  /**
   * Determines which devices should receive a push notification and which
   * have expired sessions that should be cleaned up.
   *
   * Returns `active` (subscriptions to deliver to) and `expired` (subscriptions
   * on devices with no session within SESSION_EXPIRY_WINDOW_MS — these get a
   * session-expired push and are cleaned up).
   *
   * Routing rule for active subscriptions:
   *   - If any device is currently focused AND has had a real user interaction
   *     in the last 2 minutes, push only to those device(s) — the SW on a
   *     focused device suppresses display since the user can already see Threa,
   *     and other devices stay quiet so the user doesn't get duplicate alerts
   *     where they aren't looking.
   *   - Otherwise (no focused-and-interacting device, or the user has put the
   *     phone down / walked away), fan out to every device with a live
   *     heartbeat so the user gets the notification on whichever device they
   *     pick up next.
   */
  private async getTargetSubscriptions(
    workspaceId: string,
    userId: string
  ): Promise<{ active: PushSubscription[]; expired: PushSubscription[] }> {
    // INV-30: multiple related reads share a client; INV-41: release before network I/O
    const { allSubs, activeSessions, recentDeviceKeys } = await withClient(this.pool, async (client) => {
      const subs = await PushSubscriptionRepository.findByUserId(client, workspaceId, userId)
      if (subs.length === 0)
        return {
          allSubs: subs,
          activeSessions: [] as Awaited<ReturnType<typeof UserSessionRepository.getActiveSessions>>,
          recentDeviceKeys: new Set<string>(),
        }
      const sessions = await UserSessionRepository.getActiveSessions(
        client,
        workspaceId,
        userId,
        ACTIVE_SESSION_WINDOW_MS
      )
      // Check which device keys have had any session activity within the expiry
      // window — cross-workspace, because the auth cookie is global.
      const subDeviceKeys = [...new Set(subs.map((s) => s.deviceKey))]
      const deviceKeys = await UserSessionRepository.getRecentDeviceKeys(
        client,
        subDeviceKeys,
        SESSION_EXPIRY_WINDOW_MS
      )
      return { allSubs: subs, activeSessions: sessions, recentDeviceKeys: deviceKeys }
    })
    if (allSubs.length === 0) return { active: [], expired: [] }

    // Partition subscriptions by whether the device still looks logged in.
    //
    // Two independent signals prove a device is still authenticated, and EITHER
    // keeps the subscription alive:
    //   1. A socket heartbeat for the device within the window (recentDeviceKeys,
    //      cross-workspace since the auth cookie is global).
    //   2. A recent authenticated re-registration of the subscription itself
    //      (updatedAt — the only write to this row). The frontend re-runs the
    //      idempotent subscribe handshake over HTTP on every app open/foreground.
    //      This is the signal that survives a backend socket-session timeout: on
    //      devices where WebSockets are flaky or short-lived (mobile, iOS PWA,
    //      proxies that block WS) the heartbeat never lands, but the HTTP
    //      re-register does, so the user who keeps opening the app keeps push.
    //
    // A subscription is only "expired" (→ session-expired push + cleanup) once
    // BOTH signals are stale for the full window — i.e. the device genuinely
    // hasn't logged in for ~30 days (matching the auth cookie TTL).
    const expiryThreshold = Date.now() - SESSION_EXPIRY_WINDOW_MS
    const activeSubs: PushSubscription[] = []
    const expiredSubs: PushSubscription[] = []
    for (const sub of allSubs) {
      const seenRecently = sub.updatedAt.getTime() > expiryThreshold
      if (recentDeviceKeys.has(sub.deviceKey) || seenRecently) {
        activeSubs.push(sub)
      } else {
        expiredSubs.push(sub)
      }
    }

    if (activeSubs.length === 0) return { active: [], expired: expiredSubs }

    // No live heartbeats anywhere → user is offline; fan out so they see the
    // notification on whichever device they pick up next.
    if (activeSessions.length === 0) return { active: activeSubs, expired: expiredSubs }

    // Identify devices the user is actually on right now: focused window AND a
    // real user interaction within the last 2m. A focused-but-idle window
    // (PWA running in the background of another desktop space, tab the user
    // tabbed to and then walked off) doesn't qualify.
    const now = Date.now()
    const attendedDeviceKeys = new Set(
      activeSessions
        .filter(
          (s) =>
            s.lastFocusedAt !== null &&
            now - s.lastFocusedAt.getTime() < CURRENTLY_FOCUSED_WINDOW_MS &&
            s.lastInteractionAt !== null &&
            now - s.lastInteractionAt.getTime() < RECENT_INTERACTION_WINDOW_MS
        )
        .map((s) => s.deviceKey)
    )

    if (attendedDeviceKeys.size === 0) {
      // No device proves the user is on it — fan out to every active device.
      return { active: activeSubs, expired: expiredSubs }
    }

    // Push only to the attended device(s). The SW on each device decides
    // whether to display (focused window = suppress, since the user can
    // already see Threa). If the intersection is empty (a session exists on
    // a device without a registered push subscription), fall back to fanout
    // so we still notify *something*.
    const matched = activeSubs.filter((sub) => attendedDeviceKeys.has(sub.deviceKey))
    const active = matched.length > 0 ? matched : activeSubs
    return { active, expired: expiredSubs }
  }
}
