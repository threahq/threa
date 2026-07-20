/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching"
import { resolveTag } from "./lib/sw-notification-format"
import { planRingCancel } from "./calls/call-ring-cancel"
import { isDevicePresent, PRESENCE_CACHE } from "./lib/sw-presence"
import { readVisibleStreams } from "./lib/visible-streams"
import {
  BOOTSTRAP_SYNC_TAG,
  PENDING_SYNC_CACHE,
  PENDING_SYNC_KEY,
  PUSH_BOOTSTRAP_CACHE,
  WORKSPACE_BOOTSTRAP_PATH_RE,
  parsePersistedSyncTarget,
  queueBootstrapSync,
  runBootstrapSync,
} from "./lib/sw-bootstrap-prefetch"
import {
  SW_MSG_NOTIFICATION_CLICK,
  SW_MSG_SUBSCRIPTION_CHANGED,
  SW_MSG_CLEAR_NOTIFICATIONS,
  SW_MSG_QUEUE_BOOTSTRAP_SYNC,
  SW_MSG_SKIP_WAITING,
  SHARE_TARGET_CACHE,
} from "./lib/sw-messages"

declare const self: ServiceWorkerGlobalScope

self.addEventListener("message", (event) => {
  if (event.data?.type !== SW_MSG_SKIP_WAITING) return
  void self.skipWaiting()
})

/** Extend NotificationOptions with properties supported by browsers but missing from TS lib types. */
interface ExtendedNotificationOptions extends NotificationOptions {
  /** Re-alert the user (vibrate/sound) when replacing an existing notification with the same tag. */
  renotify?: boolean
  /** Vibration pattern: alternating vibrate/pause durations in ms. Honored on Android Chromium PWAs. */
  vibrate?: number[]
}

// Distinct "d-dt" vibration (short tap, brief pause, longer tap) so Threa notifications
// feel different from the OS default dzzt-dzzt. Honored on Android Chromium PWAs; iOS
// and most desktop browsers ignore it and fall back to the OS default.
const THREA_VIBRATION_PATTERN = [30, 10, 100]

// Avatar images are versioned and immutable (URL is
// `.../avatar/<timestamp>.<size>.webp`), but the API response carries
// `Vary: Origin` from the credentialed CORS layer, which defeats the browser's
// HTTP cache — so avatars re-fetch from the network on *every* load and visibly
// pop in after the page paints (the "christmas tree" flash, made obvious once
// first paint stopped waiting on hydration). Serve them CacheFirst from a
// dedicated CacheStorage bucket: the first load fetches + stores, every
// subsequent load is an instant local hit with zero network. Safe because the
// URL changes whenever the avatar changes, so a cached entry is never stale.
const AVATAR_CACHE = "threa-avatars-v1"
const AVATAR_PATH_RE = /^\/api\/workspaces\/[^/]+\/(?:users|bots)\/[^/]+\/avatar\//
const AVATAR_CACHE_MAX_ENTRIES = 300

// New workers stay in `waiting` until the user accepts the update toast. That
// keeps an open tab on the worker/precache that match its current JS bundle.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Clean stale caches from previous SW versions. Keep only the current
      // workbox precache, push-bootstrap, and share-target caches. Without this,
      // old precache buckets linger and can serve stale HTML/CSS after an update.
      const currentCaches = new Set([
        PUSH_BOOTSTRAP_CACHE,
        SHARE_TARGET_CACHE,
        PENDING_SYNC_CACHE,
        AVATAR_CACHE,
        PRESENCE_CACHE,
      ])
      const allCaches = await caches.keys()
      await Promise.all(
        allCaches
          .filter((name) => !currentCaches.has(name) && !name.startsWith("workbox-precache-"))
          .map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

// Remove old precache entries from previous SW versions that no longer
// match the current manifest. Without this, stale revision-keyed entries
// linger and consume storage quota.
cleanupOutdatedCaches()

// Serve the build-atomic precached app shell for navigations. workbox's
// precache manifest pins index.html and the content-hashed JS/CSS it
// references to the same build, so a returning launch can never get build-A's
// HTML against build-B's now-missing assets — the post-deploy "unstyled page"
// failure where an asset URL is answered with HTML instead of JS/CSS, so React
// never mounts. Zero network on the boot critical path; post-deploy freshness
// comes from the parked-SW lifecycle (useAppUpdate drives registration.update()
// in the background and surfaces the in-app update toast once a new worker is
// downloaded and parked in `waiting`).
self.addEventListener("fetch", (event) => {
  // Only app-shell GET navigations belong here. Web Share Target launches use
  // a POST navigation to /share, which must fall through to the handler below.
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return

  // Real server navigations must reach the network, not the SPA shell:
  // /api/* (OAuth redirect), /recover (the SW-unregister recovery page,
  // deliberately excluded from the precache), and the SW/version probes.
  const { pathname } = new URL(event.request.url)
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/recover") ||
    pathname === "/sw.js" ||
    pathname === "/version.json"
  ) {
    return
  }

  event.respondWith(
    (async () => {
      // matchPrecache resolves workbox's revisioned cache key, so this is the
      // exact index.html that ships with the precached asset bundle.
      const precached = await matchPrecache("/index.html")
      if (precached) return precached
      // First ever launch / precache unavailable — go to network.
      return fetch(event.request)
    })()
  )
})

// Precache app shell assets injected by vite-plugin-pwa.
// This still handles JS/CSS/image assets with cache-first (which is fine —
// Vite content-hashes these filenames so they're immutable). Navigation
// requests are intercepted by the listener above before reaching this.
precacheAndRoute(self.__WB_MANIFEST)

// Bound the avatar cache so it can't grow without limit. `cache.keys()`
// preserves insertion order, so the oldest entries are evicted first (FIFO).
async function trimAvatarCache(cache: Cache): Promise<void> {
  const keys = await cache.keys()
  if (keys.length <= AVATAR_CACHE_MAX_ENTRIES) return
  await Promise.all(keys.slice(0, keys.length - AVATAR_CACHE_MAX_ENTRIES).map((key) => cache.delete(key)))
}

// CacheFirst for avatar images (see AVATAR_CACHE rationale above). Coexists with
// the other fetch listeners: this one only calls respondWith for avatar GETs and
// is inert for everything else, and the navigation/bootstrap listeners never
// match avatar URLs (they bail on `/api/*` or a non-matching path).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !AVATAR_PATH_RE.test(url.pathname)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(AVATAR_CACHE)
      const cached = await cache.match(event.request, { ignoreVary: true })
      if (cached) return cached

      const response = await fetch(event.request)
      // Only store a complete, same-origin 200 — never partials, errors, or
      // opaque cross-origin responses (which can't be read back reliably).
      if (response.status === 200 && response.type === "basic") {
        const copy = response.clone()
        event.waitUntil(
          cache
            .put(event.request, copy)
            .then(() => trimAvatarCache(cache))
            .catch(() => {})
        )
      }
      return response
    })()
  )
})

// Push bootstrap pre-fetch — warm stream data so it's instant on notification tap
// (stream: IndexedDB; workspace: the Cache API entry served by the interceptor).
// The prefetch logic lives in lib/sw-bootstrap-prefetch (testable without a
// ServiceWorkerGlobalScope); this file wires it to the SW events.

self.addEventListener("message", (event) => {
  if (event.data?.type !== SW_MSG_QUEUE_BOOTSTRAP_SYNC) return
  const { workspaceId, streamId, messageId, workosUserId } = event.data as {
    workspaceId?: string
    streamId?: string | null
    messageId?: string | null
    workosUserId?: string | null
  }
  if (!workspaceId) return
  event.waitUntil(
    queueBootstrapSync(
      {
        workspaceId,
        streamId: streamId ?? null,
        messageId: messageId ?? null,
        workosUserId: workosUserId ?? null,
      },
      self.registration
    )
  )
})

// Background Sync's `SyncEvent` extends ExtendableEvent but isn't in the default
// service-worker lib types, so we cast through this shape.
type SyncEvent = ExtendableEvent & { tag: string }

self.addEventListener("sync", ((event: SyncEvent) => {
  if (event.tag !== BOOTSTRAP_SYNC_TAG) return

  event.waitUntil(
    (async () => {
      const cache = await caches.open(PENDING_SYNC_CACHE)
      const cached = await cache.match(PENDING_SYNC_KEY)
      if (!cached) return

      const target = parsePersistedSyncTarget(await cached.json())
      if (!target) {
        await cache.delete(PENDING_SYNC_KEY)
        return
      }
      // Run before delete: if the run throws, the entry stays so the browser's
      // `sync` retry has a target to replay. A new `queueBootstrapSync` call
      // (e.g. another tab hide) overwrites the entry with a fresher target,
      // which is the desired behavior.
      await runBootstrapSync(target)
      await cache.delete(PENDING_SYNC_KEY)
    })()
  )
}) as EventListener)

/**
 * When the OS shares content to Threa (Web Share Target API), the browser sends
 * a POST with multipart/form-data to /share. The SW intercepts this, stashes
 * the form data (text fields + files) into the Cache API, and responds with a
 * redirect to the GET /share page where the app picks it up.
 */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.pathname !== "/share" || event.request.method !== "POST") return

  event.respondWith(
    (async () => {
      try {
        const formData = await event.request.formData()
        const title = formData.get("title") as string | null
        const text = formData.get("text") as string | null
        const sharedUrl = formData.get("url") as string | null
        const files = formData.getAll("files") as File[]

        const cache = await caches.open(SHARE_TARGET_CACHE)

        const keys = await cache.keys()
        for (const key of keys) await cache.delete(key)

        // Store files first so fileCount in meta is always accurate —
        // if a file write fails mid-loop, meta records only the files
        // that were actually persisted.
        let storedFileCount = 0
        for (let i = 0; i < files.length; i++) {
          await cache.put(
            new Request(`/_share/file/${i}`),
            new Response(files[i], {
              headers: {
                "Content-Type": files[i].type,
                "X-Filename": encodeURIComponent(files[i].name),
                "X-Size": String(files[i].size),
              },
            })
          )
          storedFileCount++
        }

        // Store metadata last — fileCount reflects only successfully stored files
        await cache.put(
          new Request("/_share/meta"),
          new Response(JSON.stringify({ title, text, url: sharedUrl, fileCount: storedFileCount }))
        )
      } catch {
        // Best-effort — if stashing fails, the redirect still lands on /share
        // and the user sees the normal share picker (just without pre-populated content).
      }

      return Response.redirect("/share", 303)
    })()
  )
})

/**
 * Fetch interceptor: serve the pre-fetched WORKSPACE bootstrap response from the
 * push cache. Entries are one-shot — deleted after being served so subsequent
 * fetches hit the network.
 *
 * Stream bootstrap is deliberately NOT served from this cache. The prefetch
 * warms IndexedDB, so the timeline paints instantly from useLiveQuery either
 * way; the page's own bootstrap GET is left to pass through to the network and
 * apply the fresh result on top of that warm paint (stale-while-revalidate, in
 * the page's own sync pipeline). Replaying a cached stream snapshot instead
 * would (a) serve data captured before activity that landed while the tab was
 * away — a reaction, an edit — with no revalidation, and (b) make the request
 * service-worker-initiated, so the page's catch-up fetch never reaches the
 * network. The workspace bootstrap has no SW-side IDB apply path, so its
 * cache serve stays.
 *
 * Uses a regex guard (not an in-memory Set) because mobile browsers terminate
 * the SW between push receipt and notification tap — any in-memory state would
 * be lost, orphaning the cache entry. The Cache API is persistent and is the
 * sole source of truth. The per-request cost of a regex test + async cache miss
 * is sub-millisecond — negligible compared to the network round-trip it replaces
 * on a cache hit.
 */
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (!WORKSPACE_BOOTSTRAP_PATH_RE.test(url.pathname)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(PUSH_BOOTSTRAP_CACHE)
      const cached = await cache.match(event.request.url)
      if (cached) {
        // One-shot: serve and delete so the next fetch gets fresh data
        void cache.delete(event.request.url)
        return cached
      }
      return fetch(event.request)
    })()
  )
})

/** Structured push payload — display text is formatted here, not on the backend (INV-46). */
interface PushData {
  workspaceId?: string
  /**
   * Recipient account's WorkOS user id. Lets the app flip the active account
   * in place before opening the deep link when the click lands under a
   * different signed-in account. Stamped by the backend (push/service.ts);
   * duplicated here because there is no shared types package for this wire
   * contract (mirrors the rest of PushData).
   */
  workosUserId?: string
  streamId?: string
  messageId?: string
  /**
   * Conversation origin for a saved-reminder push — when present the click
   * opens the conversation panel (`/board?panel=conv:<id>&m=<msgId>`) rather
   * than the stream permalink. Duplicated wire field like the rest of PushData.
   */
  conversationId?: string
  activityType?: string
  contentPreview?: string
  streamName?: string
  authorName?: string
  /** Reaction emoji — present only for "reaction" activity; drives the "X reacted 👍 to …" line. */
  emoji?: string
  /** Rolling message history accumulated by the SW for grouped notifications. */
  messages?: Array<{ authorName?: string; contentPreview?: string; emoji?: string }>
  /** Backend-driven action: "clear" dismisses notifications for the stream; "session_expired" prompts re-login. */
  action?: "clear" | "session_expired"
  /**
   * Payload kind: "test" is sent by the in-app diagnostic to verify
   * end-to-end delivery; "saved_reminder" marks reminder pushes so clicks on
   * standalone (message-less) items can land on the Saved page;
   * "rewrap_needed" pulls the owner back to re-key a stuck encrypted scratchpad;
   * "call_ring" is an incoming DM call, "call_ring_cancel" retracts it;
   * "missed_call" is a ring that lapsed while the app was closed.
   */
  kind?: "test" | "saved_reminder" | "rewrap_needed" | "call_ring" | "call_ring_cancel" | "missed_call"
  /** Ring attempt id (invitation id) — the `call-<attemptId>` notification tag key. */
  attemptId?: string
  /** Call id a ring click accepts into. */
  callId?: string
  /** Inviter display name for the ring notification title. */
  inviterName?: string
  /** Ring media mode ("video" | "audio_only"). */
  mode?: string
  /** ISO deadline the ring lapses at. */
  expiresAt?: string
}

self.addEventListener("push", (event) => {
  if (!event.data) return

  let data: PushData
  try {
    const payload = event.data.json() as { data?: PushData }
    data = payload.data ?? {}
  } catch {
    // Fallback for malformed payloads
    data = {}
  }

  // Legacy backend-driven clear. The backend no longer sends these — a push
  // that shows no notification burns the browser's silent-push quota (Firefox
  // revokes the subscription at 0) — but clears queued for offline devices
  // before that change carried a 28-day TTL, so this guard must survive one
  // TTL window to keep a straggler from falling through to the display path
  // and rendering a junk notification. Safe to delete after 2026-08-05.
  if (data.action === "clear") {
    if (!data.streamId) return
    event.waitUntil(
      Promise.all([
        self.registration.getNotifications({ tag: data.streamId }),
        self.registration.getNotifications({ tag: `${data.streamId}:mention` }),
      ]).then(([streamNotifs, mentionNotifs]) => {
        for (const n of [...streamNotifs, ...mentionNotifs]) n.close()
      })
    )
    return
  }

  // Test push from the in-app diagnostic. Always display, even with the app
  // focused — the user explicitly asked to verify the delivery loop, so
  // suppressing it would defeat the purpose.
  if (data.kind === "test") {
    event.waitUntil(
      self.registration.showNotification("Threa test notification", {
        body: "Push delivery is working — you should see this on every subscribed device.",
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: "threa-test",
        renotify: true,
        vibrate: THREA_VIBRATION_PATTERN,
        data: { ...data, kind: "test" },
      } as ExtendedNotificationOptions)
    )
    return
  }

  // Session expired: the user's auth has expired and their push subscriptions
  // have been cleaned up. Show a one-shot notification so they know to log back in.
  if (data.action === "session_expired") {
    event.waitUntil(
      self.registration.showNotification("Session expired", {
        body: "Your session has expired. Tap to sign back in.",
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: "session-expired",
        vibrate: THREA_VIBRATION_PATTERN,
        data: { ...data, action: "session_expired" },
      } as ExtendedNotificationOptions)
    )
    return
  }

  // Re-wrap nudge: an enclave turn in the owner's encrypted scratchpad is stuck
  // until they reopen the app so their unlocked device can re-key the stream.
  // Always display — by the time this fires the owner is away (a focused tab
  // would already have healed it over the socket), so suppressing would strand
  // the turn. The click lands on the stream via the generic deep-link below.
  if (data.kind === "rewrap_needed") {
    event.waitUntil(
      self.registration.showNotification("Your assistant is waiting", {
        body: "Unlock Threa to let your assistant reply in your encrypted scratchpad.",
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: data.streamId ? `rewrap:${data.streamId}` : "rewrap",
        renotify: true, // Re-alert (vibrate/sound) when a later nudge replaces an earlier same-tag one
        vibrate: THREA_VIBRATION_PATTERN,
        data: { ...data, kind: "rewrap_needed" },
      } as ExtendedNotificationOptions)
    )
    return
  }

  // Incoming call ring. Always display (a ring the user isn't looking at is the
  // whole point) with a distinct tag so the in-app socket-fallback notification
  // and this push collapse to one entry per attempt. `renotify` re-alerts.
  // Clicking opens/focuses the app to the host stream with `?call=<callId>`,
  // which the app reads as accept-intent (declining from the notification is
  // v1-omitted — no notification action buttons yet).
  if (data.kind === "call_ring") {
    if (!data.attemptId) return
    event.waitUntil(
      self.registration.showNotification(data.inviterName ? `${data.inviterName} is calling…` : "Incoming call…", {
        body: data.mode === "audio_only" ? "Voice call" : "Video call",
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: `call-${data.attemptId}`,
        renotify: true,
        vibrate: THREA_VIBRATION_PATTERN,
        data: { ...data, kind: "call_ring" },
      } as ExtendedNotificationOptions)
    )
    return
  }

  // Ring retracted (accepted elsewhere / declined / cancelled / expired). Close
  // the tagged ring notification best-effort — platform retract support varies
  // (some won't remove an already-shown notification), documented in the plan.
  // When nothing was closed the cancel collapsed a ring this device never showed
  // (offline topic-collapse); show a minimal, silent "Call ended" so the push is
  // never notification-less (a silent-result push burns the browser's silent-push
  // quota — Firefox revokes the subscription at 0).
  if (data.kind === "call_ring_cancel") {
    if (!data.attemptId) return
    event.waitUntil(
      self.registration.getNotifications({ tag: `call-${data.attemptId}` }).then((ns) => {
        for (const n of ns) n.close()
        const plan = planRingCancel(ns.length, data)
        if (plan.show) {
          return self.registration.showNotification(plan.title, plan.options as ExtendedNotificationOptions)
        }
      })
    )
    return
  }

  // Missed call (ring expired while the app was closed). Its own copy — the
  // generic message-grouping path below has no missed_call branch and would
  // title the banner "New message" with the caller's name as the body. Clicking
  // opens the host stream via the generic deep-link handler.
  if (data.kind === "missed_call") {
    const inviter = data.authorName
    const where = data.streamName ? ` in ${data.streamName}` : ""
    event.waitUntil(
      self.registration.showNotification(inviter ? `Missed call from ${inviter}` : "Missed call", {
        body: (data.mode === "audio_only" ? "Voice call" : "Video call") + where,
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: data.streamId ? `missed-call:${data.streamId}` : "missed-call",
        renotify: true,
        vibrate: THREA_VIBRATION_PATTERN,
        data: { ...data, kind: "missed_call" },
      } as ExtendedNotificationOptions)
    )
    return
  }

  // Lazy-import pure formatting helpers (keeps SW entry point lean)
  const fmt = import("./lib/sw-notification-format")

  // Tag by stream, with mentions on a separate tag so they stay visually distinct.
  const tag = data.streamId ? resolveTag(data.streamId, data.activityType) : "threa-notification"

  // Suppress only when a focused window is already viewing THIS stream AND the
  // device was interacted with recently — the user can actually see the message
  // there. A push for any other stream still shows even with the app focused, so
  // you're alerted to conversations you aren't looking at (e.g. viewing the DM
  // with Pierre doesn't mute a new message in #general). Requiring recent
  // interaction (not focus alone) means a tab left focused and walked away from
  // ages out and stops eating notifications — matching the backend's attended
  // rule. Backend always sends the push; the SW decides whether to display it.
  // Skipping only the on-screen stream also keeps us off the userVisibleOnly
  // silent-push budget that browsers penalize on mobile.
  //
  // "Viewing" is two signals, either suffices: the window URL matches the
  // stream route (/w/:ws/s/:id), or the page registered the stream as
  // on-screen in the visible-streams presence entry — threads and
  // conversations render as `?panel=` params (on any route, including /board),
  // so their stream ids never appear in the URL path and only the registry
  // knows they're being read.
  event.waitUntil(
    Promise.all([fmt, self.clients.matchAll({ type: "window", includeUncontrolled: true }), readVisibleStreams()]).then(
      async ([{ appendMessage, formatTitle, formatBody, isViewingStream }, clients, visibleStreams]) => {
        const focusedClients = clients.filter((c) => c.focused && new URL(c.url).origin === self.location.origin)
        const viewingThisStream =
          focusedClients.some((c) => isViewingStream(c.url, data.workspaceId, data.streamId)) ||
          (focusedClients.length > 0 && !!data.streamId && visibleStreams.has(data.streamId))
        if (viewingThisStream && (await isDevicePresent())) return

        // Accumulate a rolling list of recent messages from the existing notification
        const existing = await self.registration.getNotifications({ tag })
        const previousMessages = (existing[0]?.data as PushData | undefined)?.messages ?? []
        const messages = appendMessage(previousMessages, {
          authorName: data.authorName,
          contentPreview: data.contentPreview,
          emoji: data.emoji,
        })

        const title = formatTitle(messages, data.streamName, data.activityType)
        const body = formatBody(messages)

        const options: ExtendedNotificationOptions = {
          body,
          icon: "/threa-logo-192.png",
          badge: "/threa-logo-192.png",
          data: { ...data, messages },
          tag,
          renotify: true, // Re-alert (vibrate/sound) even when replacing an existing notification
          vibrate: THREA_VIBRATION_PATTERN,
        }

        // Re-alerting a replaced same-tag notification depends on `renotify`,
        // which Firefox, iOS/Safari, and some Chromium builds ignore — they
        // swap the tray entry silently, so every message after the first in a
        // stream arrives with no sound/vibration/banner. Closing the
        // predecessor (its message history is already lifted into `messages`
        // above, so the grouped body/count survives) means showNotification has
        // no same-tag entry to silently replace and reliably re-alerts on every
        // platform.
        for (const n of existing) n.close()

        await self.registration.showNotification(title, options)

        // Queue a Background Sync to prefetch stream + workspace bootstrap so
        // the data is fresh when the user taps the notification. Going through
        // queueBootstrapSync (vs. inline fetch) means a flaky network or an
        // SW termination won't leave the user staring at a stale stream — the
        // browser retries `sync` until it succeeds. Best-effort: errors here
        // never block notification display.
        if (data.workspaceId) {
          await queueBootstrapSync(
            {
              workspaceId: data.workspaceId,
              streamId: data.streamId ?? null,
              messageId: data.messageId ?? null,
              workosUserId: data.workosUserId ?? null,
            },
            self.registration
          ).catch(() => {})
        }
      }
    )
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const data = event.notification.data as PushData | undefined
  let targetUrl = "/"

  if (data?.workspaceId && data?.callId && data.kind === "call_ring") {
    // Ring click = accept-intent: land on the host stream with `?call=<callId>`,
    // which the app interprets as "join this call".
    targetUrl = data.streamId
      ? `/w/${data.workspaceId}/s/${data.streamId}?call=${data.callId}`
      : `/w/${data.workspaceId}?call=${data.callId}`
  } else if (data?.workspaceId && data?.conversationId) {
    // Conversation origin wins over the stream permalink: reopen the message in
    // the conversation panel. `conv:` is the panel-id wire prefix
    // (createConversationPanelId); inlined here since the SW can't import the
    // React panel-context module.
    const params = new URLSearchParams({ panel: `conv:${data.conversationId}` })
    if (data.messageId) params.set("m", data.messageId)
    targetUrl = `/w/${data.workspaceId}/board?${params.toString()}`
  } else if (data?.workspaceId && data?.streamId) {
    targetUrl = data.messageId
      ? `/w/${data.workspaceId}/s/${data.streamId}?m=${data.messageId}`
      : `/w/${data.workspaceId}/s/${data.streamId}`
  } else if (data?.workspaceId && data.kind === "saved_reminder") {
    // Standalone saved-item reminder — no source message to open, so land on
    // the Saved page where the item lives.
    targetUrl = `/w/${data.workspaceId}/saved`
  } else if (data?.workspaceId) {
    targetUrl = `/w/${data.workspaceId}`
  }

  const absoluteUrl = new URL(targetUrl, self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus()
          client.postMessage({
            type: SW_MSG_NOTIFICATION_CLICK,
            url: targetUrl,
            workosUserId: data?.workosUserId,
          })
          return
        }
      }
      // Use absolute URL so browsers that associate the full URL with the manifest
      // scope (e.g. for PWA standalone windows) can open in the correct context.
      await self.clients.openWindow(absoluteUrl)
    })
  )
})

// Clear notifications when the user reads a stream in the app.
self.addEventListener("message", (event) => {
  if (event.data?.type !== SW_MSG_CLEAR_NOTIFICATIONS) return
  const streamId = event.data.streamId as string | undefined
  if (!streamId) return

  event.waitUntil(
    Promise.all([
      self.registration.getNotifications({ tag: streamId }),
      self.registration.getNotifications({ tag: `${streamId}:mention` }),
      self.registration.getNotifications({ tag: `rewrap:${streamId}` }),
    ]).then((groups) => {
      for (const n of groups.flat()) n.close()
    })
  )
})

self.addEventListener("pushsubscriptionchange", (event) => {
  // The old subscription has been invalidated — re-subscribe with the same
  // applicationServerKey and POST the new subscription to the backend.
  // Note: this event is rare (key rotation, browser storage cleared).
  const evt = event as ExtendableEvent & {
    oldSubscription?: PushSubscription
    newSubscription?: PushSubscription
  }

  evt.waitUntil(
    (async () => {
      try {
        const oldSub = evt.oldSubscription
        const applicationServerKey = oldSub?.options.applicationServerKey
        if (!applicationServerKey && !evt.newSubscription) {
          // No VAPID key available and no new subscription provided — can't re-subscribe.
          // The hook will re-subscribe with the correct key on next app load.
          return
        }

        const newSub =
          evt.newSubscription ??
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          }))

        if (!newSub) return

        // Notify the frontend so it can re-register the new subscription with the backend.
        // The SW doesn't have workspace context, so the app handles the API call.
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })

        if (clients.length === 0) {
          // No open windows — the SW can't register with the backend itself
          // (no workspace context or auth). The re-subscribe above keeps the
          // browser side warm; usePushNotifications re-registers it on next
          // app open (mount) or within LIVENESS_CHECK_INTERVAL_MS on an
          // already-open tab, as a plain idempotent upsert.
          return
        }

        for (const client of clients) {
          client.postMessage({
            type: SW_MSG_SUBSCRIPTION_CHANGED,
            subscription: newSub.toJSON(),
          })
        }
      } catch {
        // Swallow error — the usePushNotifications hook will re-subscribe on next app load
      }
    })()
  )
})
