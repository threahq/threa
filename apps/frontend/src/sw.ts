/// <reference lib="webworker" />
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching"
import { AuthorTypes, type LastMessagePreview, type StreamEvent } from "@threa/types"
import { resolveTag } from "./lib/sw-notification-format"
import {
  SW_MSG_NOTIFICATION_CLICK,
  SW_MSG_SUBSCRIPTION_CHANGED,
  SW_MSG_CLEAR_NOTIFICATIONS,
  SW_MSG_QUEUE_BOOTSTRAP_SYNC,
  SW_MSG_RELOAD_FRESH,
  SHARE_TARGET_CACHE,
} from "./lib/sw-messages"

declare const self: ServiceWorkerGlobalScope

/**
 * One-shot: serve the next app-shell navigation from the network instead of the
 * cache-first precache. Set by the "new version" reload (SW_MSG_RELOAD_FRESH)
 * so the reload fetches the freshly-deployed index.html — the precache here is
 * still the *old* build until the new SW installs and claims, so a plain
 * cache-first reload would just re-serve the old client. In-memory is fine: the
 * page reloads within milliseconds of the ack, so the flag never needs to
 * survive an SW restart, and if it somehow does reset we fall back to the safe
 * cache-first path (no worse than before).
 */
let serveNextNavFromNetwork = false

self.addEventListener("message", (event) => {
  if (event.data?.type !== SW_MSG_RELOAD_FRESH) return
  serveNextNavFromNetwork = true
  // Ack so the page reloads only once the flag is set, guaranteeing the
  // navigation that follows is the one served from the network.
  event.ports[0]?.postMessage({ ok: true })
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

// Activate new service worker immediately so users get fresh code
// without needing to close all tabs.
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Clean stale caches from previous SW versions. Keep only the current
      // workbox precache, push-bootstrap, and share-target caches. Without this,
      // old precache buckets linger and can serve stale HTML/CSS after an update.
      const currentCaches = new Set([PUSH_BOOTSTRAP_CACHE, SHARE_TARGET_CACHE, PENDING_SYNC_CACHE])
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
// failure (where _redirects' `/* /index.html 200` SPA fallback serves HTML in
// place of deleted asset URLs, so React never mounts). Zero network on the
// boot critical path; post-deploy freshness comes from the SW update
// lifecycle (skipWaiting/clients.claim above) surfaced by the in-app
// version.json update toast.
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
      // One-shot network-first: the user clicked "Reload" on the new-version
      // toast. Fetch the freshly-deployed shell so the reload lands on the new
      // build instead of this (old) SW's precached shell. Falls through to the
      // precache if the network fails (offline) so the reload still yields a
      // working app.
      if (serveNextNavFromNetwork) {
        serveNextNavFromNetwork = false
        try {
          return await fetch(event.request)
        } catch {
          // Offline — fall through to the precached shell below.
        }
      }
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

// ============================================================================
// Push bootstrap pre-fetch — warm stream data so it's instant on notification tap
// (stream: IndexedDB; workspace: the Cache API entry served by the interceptor)
// ============================================================================

/** Cache name for pre-fetched workspace bootstrap responses triggered by push or background sync. */
const PUSH_BOOTSTRAP_CACHE = "push-bootstrap"

/** Cache name used to persist pending Background Sync targets across SW restarts. */
const PENDING_SYNC_CACHE = "pending-sync"

/** Single sync tag for bootstrap refresh — browsers coalesce repeat registrations under the same tag. */
const BOOTSTRAP_SYNC_TAG = "threa-bootstrap-refresh"

/** Cache key for the persisted sync target. Last write wins; only the most recent target is replayed. */
const PENDING_SYNC_KEY = `/_sync/${BOOTSTRAP_SYNC_TAG}`

/** Regex matching workspace bootstrap API paths. */
const WORKSPACE_BOOTSTRAP_PATH_RE = /^\/api\/workspaces\/[^/]+\/bootstrap$/

interface BootstrapSyncTarget {
  workspaceId: string
  streamId: string | null
  messageId: string | null
}

/**
 * Pre-fetch events around a specific message so it's available in IDB
 * when the user taps the push notification. Best-effort.
 */
async function prefetchEventsAround(workspaceId: string, streamId: string, messageId: string): Promise<void> {
  try {
    const url = `/api/workspaces/${workspaceId}/streams/${streamId}/events/around?messageId=${messageId}&limit=30`
    const response = await fetch(url, { credentials: "include" })
    if (!response.ok) return

    const body = await response.json()
    const data = body.data ?? body
    if (data?.events?.length > 0) {
      const now = Date.now()
      const { db, sequenceToNum } = await import("./db/database")
      await db.events.bulkPut(
        data.events.map((e: Record<string, unknown>) => ({
          ...e,
          workspaceId,
          _sequenceNum: sequenceToNum(e.sequence as string),
          _cachedAt: now,
        }))
      )
    }
  } catch {
    // Best-effort
  }
}

async function prefetchStreamBootstrap(workspaceId: string, streamId: string): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/streams/${streamId}/bootstrap`
  const response = await fetch(url, { credentials: "include" })
  if (!response.ok) return

  // Warm IndexedDB so useLiveQuery renders the stream instantly when the user
  // taps the notification. We deliberately do NOT cache the response for the
  // fetch interceptor to replay: the page's own bootstrap GET passes through to
  // the network and applies the fresh result on top of this warm paint
  // (stale-while-revalidate), so replaying a snapshot captured before later
  // activity would only reintroduce staleness. Best-effort: errors are swallowed.
  try {
    const body = await response.json()
    const bootstrap = body.data ?? body
    if (!bootstrap?.events?.length) return

    const now = Date.now()
    // Dynamic import to avoid bundling Dexie into the SW critical path.
    // The SW shares the same origin and IndexedDB database as the main thread.
    const { db, sequenceToNum } = await import("./db/database")

    const events: StreamEvent[] = bootstrap.events
    const latestMessageEvent = findLatestMessageEvent(events)
    const derivedPreview = latestMessageEvent ? buildPreviewFromEvent(latestMessageEvent) : null

    // The stream bootstrap endpoint returns a plain Stream without
    // lastMessagePreview — a blind put would wipe the sidebar preview and
    // sink the stream into "Other". Merge via update() so lastMessagePreview
    // and membership-derived fields (pinned, notificationLevel,
    // lastReadEventId) from applyWorkspaceBootstrap survive.
    await db.transaction("rw", [db.events, db.streams], async () => {
      await db.events.bulkPut(
        events.map((e) => ({
          ...e,
          workspaceId,
          _sequenceNum: sequenceToNum(e.sequence),
          _cachedAt: now,
        }))
      )

      if (!bootstrap.stream) return

      const patch: { _cachedAt: number; lastMessagePreview?: LastMessagePreview } = { _cachedAt: now }
      if (derivedPreview) patch.lastMessagePreview = derivedPreview

      const updated = await db.streams.update(bootstrap.stream.id, patch)
      if (updated === 0) {
        await db.streams.put({ ...bootstrap.stream, ...patch })
      }
    })
  } catch {
    // Best-effort — normal fetch path takes over if this fails
  }
}

/**
 * Pre-fetch the workspace bootstrap so the next workspace bootstrap fetch in the
 * page is served from the warm push cache by the interceptor above.
 *
 * Errors propagate so the `sync` event handler sees the rejection and the
 * browser retries Background Sync. Inline callers (push handler, no-sync
 * fallback) catch separately and treat failures as best-effort.
 *
 * Unlike stream bootstrap, we don't seed IDB here — the workspace bootstrap
 * apply pipeline is large and lives in workspace-sync; running it from the SW
 * would duplicate that surface. Cache-API hydration alone is enough because
 * TanStack always issues a fresh GET on app load and that GET hits the cache.
 */
async function prefetchWorkspaceBootstrap(workspaceId: string): Promise<void> {
  const url = `/api/workspaces/${workspaceId}/bootstrap`
  const response = await fetch(url, { credentials: "include" })
  if (!response.ok) return
  const cache = await caches.open(PUSH_BOOTSTRAP_CACHE)
  await cache.put(url, response)
}

/**
 * Run a bootstrap prefetch for the given target. Pure-ish: does network + cache
 * + IDB writes but no event-listener wiring, so unit tests can drive it directly.
 *
 * Stream prefetch runs first because that's the user's perceived loading path
 * after tapping a notification; workspace prefetch is the ambient sidebar
 * freshness pass that can land slightly later without affecting the open-stream
 * experience.
 */
export async function runBootstrapSync(target: BootstrapSyncTarget): Promise<void> {
  if (target.streamId) {
    await prefetchStreamBootstrap(target.workspaceId, target.streamId)
    if (target.messageId) {
      await prefetchEventsAround(target.workspaceId, target.streamId, target.messageId)
    }
  }
  await prefetchWorkspaceBootstrap(target.workspaceId)
}

/**
 * Persist the sync target and register a Background Sync. The browser fires the
 * `sync` event once connectivity is available and retries on failure, so the
 * prefetch survives flaky networks and SW termination.
 *
 * Browsers without Background Sync (Safari, Firefox) throw on register — we
 * fall through to running the prefetch immediately. Inline runs delete the
 * persisted target after the run so a sync-capable browser that gains support
 * later (or a leftover entry from a previous SW version) doesn't replay stale.
 */
async function queueBootstrapSync(target: BootstrapSyncTarget): Promise<void> {
  const cache = await caches.open(PENDING_SYNC_CACHE)
  await cache.put(
    PENDING_SYNC_KEY,
    new Response(JSON.stringify(target), { headers: { "Content-Type": "application/json" } })
  )

  const reg = self.registration as ServiceWorkerRegistration & {
    sync?: { register: (tag: string) => Promise<void> }
  }
  if (reg.sync) {
    try {
      await reg.sync.register(BOOTSTRAP_SYNC_TAG)
      return
    } catch {
      // Fall through to immediate prefetch below
    }
  }

  try {
    await runBootstrapSync(target)
  } finally {
    void caches.open(PENDING_SYNC_CACHE).then((c) => c.delete(PENDING_SYNC_KEY))
  }
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== SW_MSG_QUEUE_BOOTSTRAP_SYNC) return
  const { workspaceId, streamId, messageId } = event.data as {
    workspaceId?: string
    streamId?: string | null
    messageId?: string | null
  }
  if (!workspaceId) return
  event.waitUntil(
    queueBootstrapSync({
      workspaceId,
      streamId: streamId ?? null,
      messageId: messageId ?? null,
    })
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

      const target = (await cached.json()) as BootstrapSyncTarget
      // Run before delete: if the run throws, the entry stays so the browser's
      // `sync` retry has a target to replay. A new `queueBootstrapSync` call
      // (e.g. another tab hide) overwrites the entry with a fresher target,
      // which is the desired behavior.
      await runBootstrapSync(target)
      await cache.delete(PENDING_SYNC_KEY)
    })()
  )
}) as EventListener)

/** Find the most recent message_created event. Bootstrap events are ordered oldest → newest. */
function findLatestMessageEvent(events: StreamEvent[]): StreamEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].eventType === "message_created") return events[i]
  }
  return null
}

function buildPreviewFromEvent(event: StreamEvent): LastMessagePreview {
  const payload = (event.payload ?? {}) as { contentJson?: unknown; contentMarkdown?: string }
  return {
    authorId: event.actorId ?? "",
    authorType: event.actorType ?? AuthorTypes.USER,
    // Sidebar's truncateContent accepts either JSONContent or a markdown string.
    content: (payload.contentJson ?? payload.contentMarkdown ?? "") as string,
    createdAt: event.createdAt,
  }
}

// ============================================================================
// Share Target POST interception — stash files + text for the app to read
// ============================================================================

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

        // Clear any previous share data
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
      // No pre-fetched data — pass through to network
      return fetch(event.request)
    })()
  )
})

// ============================================================================
// Push notification handling
// ============================================================================

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
  activityType?: string
  contentPreview?: string
  streamName?: string
  authorName?: string
  /** Rolling message history accumulated by the SW for grouped notifications. */
  messages?: Array<{ authorName?: string; contentPreview?: string }>
  /** Backend-driven action: "clear" dismisses notifications for the stream; "session_expired" prompts re-login. */
  action?: "clear" | "session_expired"
  /** Payload kind: "test" is sent by the in-app diagnostic to verify end-to-end delivery. */
  kind?: "test"
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

  // Backend-driven clear: dismiss notifications for this stream across all devices.
  // Clear both the regular stream tag and the mention tag so reading a stream
  // dismisses all notification groups for it.
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

  // Lazy-import pure formatting helpers (keeps SW entry point lean)
  const fmt = import("./lib/sw-notification-format")

  // Tag by stream, with mentions on a separate tag so they stay visually distinct.
  const tag = data.streamId ? resolveTag(data.streamId, data.activityType) : "threa-notification"

  // Suppress notification if the user has a focused app window — they can already see the message.
  // Backend always sends the push; the SW decides whether to display it.
  event.waitUntil(
    Promise.all([fmt, self.clients.matchAll({ type: "window", includeUncontrolled: true })]).then(
      async ([{ appendMessage, formatTitle, formatBody }, clients]) => {
        const hasFocusedWindow = clients.some((c) => c.focused && new URL(c.url).origin === self.location.origin)
        if (hasFocusedWindow) return

        // Accumulate a rolling list of recent messages from the existing notification
        const existing = await self.registration.getNotifications({ tag })
        const previousMessages = (existing[0]?.data as PushData | undefined)?.messages ?? []
        const messages = appendMessage(previousMessages, {
          authorName: data.authorName,
          contentPreview: data.contentPreview,
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
          await queueBootstrapSync({
            workspaceId: data.workspaceId,
            streamId: data.streamId ?? null,
            messageId: data.messageId ?? null,
          }).catch(() => {})
        }
      }
    )
  )
})

// ============================================================================
// Notification click — focus existing window or open new one
// ============================================================================

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const data = event.notification.data as PushData | undefined
  let targetUrl = "/"

  if (data?.workspaceId && data?.streamId) {
    targetUrl = data.messageId
      ? `/w/${data.workspaceId}/s/${data.streamId}?m=${data.messageId}`
      : `/w/${data.workspaceId}/s/${data.streamId}`
  } else if (data?.workspaceId) {
    targetUrl = `/w/${data.workspaceId}`
  }

  const absoluteUrl = new URL(targetUrl, self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      // Focus an existing window if one is open
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
      // No existing window — open a new one.
      // Use absolute URL so browsers that associate the full URL with the manifest
      // scope (e.g. for PWA standalone windows) can open in the correct context.
      await self.clients.openWindow(absoluteUrl)
    })
  )
})

// ============================================================================
// Clear notifications when the user reads a stream in the app
// ============================================================================

self.addEventListener("message", (event) => {
  if (event.data?.type !== SW_MSG_CLEAR_NOTIFICATIONS) return
  const streamId = event.data.streamId as string | undefined
  if (!streamId) return

  event.waitUntil(
    Promise.all([
      self.registration.getNotifications({ tag: streamId }),
      self.registration.getNotifications({ tag: `${streamId}:mention` }),
    ]).then(([streamNotifs, mentionNotifs]) => {
      for (const n of [...streamNotifs, ...mentionNotifs]) n.close()
    })
  )
})

// ============================================================================
// Re-subscribe on push subscription change
// ============================================================================

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
          // No open windows — persist to IndexedDB so the app can sync on next load.
          // The usePushNotifications hook re-subscribes on mount anyway (idempotent upsert),
          // so a lost change event is recovered naturally when the user reopens the app.
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
