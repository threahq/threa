/// <reference lib="webworker" />
import { PrecacheController, PrecacheRoute } from "workbox-precaching"
import { NavigationRoute, registerRoute } from "workbox-routing"
import { resolveTag } from "./lib/sw-notification-format"
import { planRingCancel, type RingCancelData } from "./calls/call-ring-cancel"
import { isDevicePresent } from "./lib/sw-presence"
import { readVisibleStreams } from "./lib/visible-streams"
import {
  BOOTSTRAP_SYNC_TAG,
  PENDING_SYNC_CACHE,
  PENDING_SYNC_KEY,
  PUSH_BOOTSTRAP_CACHE,
  WORKSPACE_BOOTSTRAP_PATH_RE,
  parsePersistedSyncTarget,
  queueBootstrapSync,
  respondToBootstrapRequest,
  runBootstrapSync,
} from "./lib/sw-bootstrap-prefetch"
import {
  SW_MSG_NOTIFICATION_CLICK,
  SW_MSG_SUBSCRIPTION_CHANGED,
  SW_MSG_CLEAR_NOTIFICATIONS,
  SW_MSG_QUEUE_BOOTSTRAP_SYNC,
  SW_MSG_SKIP_WAITING,
  SW_MSG_QUERY_STATUS,
  SW_MSG_STATUS_REPLY,
  SW_MSG_APPLY_UPDATE,
  SW_MSG_QUERY_BUILD,
  SW_MSG_BUILD_REPLY,
  SW_MSG_RUN_GC,
  SW_MSG_GC_REPLY,
  SHARE_TARGET_CACHE,
} from "./lib/sw-messages"

declare const self: ServiceWorkerGlobalScope
declare const __APP_VERSION__: string
declare const __APP_BUILD_ID__: string

const BUILD_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "unknown"
const BUILD_ID = typeof __APP_BUILD_ID__ === "string" ? __APP_BUILD_ID__ : BUILD_VERSION

const PRECACHE_CACHE_NAME = `workbox-precache-${BUILD_ID}`
const PRECACHE_LOCK = "threa-precache"

/** Extend NotificationOptions with properties supported by browsers but missing from TS lib types. */
interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean
  vibrate?: number[]
}

const THREA_VIBRATION_PATTERN = [30, 10, 100]

const AVATAR_CACHE = "threa-avatars-v1"
const AVATAR_PATH_RE = /^\/api\/workspaces\/[^/]+\/(?:users|bots)\/[^/]+\/avatar\//
const AVATAR_CACHE_MAX_ENTRIES = 300

/**
 * Per-artifact precache controller. Each build gets its own cache bucket so an
 * old tab keeps its complete precache untouched while a new build installs into
 * a fresh bucket. Integrity from the manifest is honored on every precache
 * request; a failed fetch or cache write aborts the install.
 */
const precacheController = new PrecacheController({
  cacheName: PRECACHE_CACHE_NAME,
  fallbackToNetwork: true,
})

precacheController.addToCacheList(self.__WB_MANIFEST)

self.addEventListener("install", (event) => {
  const install = () => precacheController.install(event)
  event.waitUntil(self.navigator.locks ? self.navigator.locks.request(PRECACHE_LOCK, install) : install())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Remove only entries no longer in this worker's manifest. The cache
      // bucket itself is build-scoped, so there is no old build precache here
      // to wipe. Keep the first-install/push clients.claim behavior.
      await precacheController.activate(event)
      await self.clients.claim()
    })()
  )
})

// Serve precached assets (JS/CSS/fonts/etc.) and the app shell for navigations.
registerRoute(new PrecacheRoute(precacheController))
registerRoute(
  new NavigationRoute(
    async ({ request }) => {
      const shell = await precacheController.matchPrecache("/index.html")
      return shell ?? fetch(request)
    },
    {
      denylist: [/^\/api\//, /^\/recover/, /^\/sw\.js$/, /^\/version\.json$/],
    }
  )
)

const ASSET_PATH_RE = /^\/assets\/[^/]+-[\w-]+\.(?:m?js|css|woff2?|png|svg|ico)$/

/**
 * Fallback for a same-origin, content-hashed /assets/ URL that is not in this
 * build's manifest — e.g. an old tab lazy-importing its own chunk after a
 * newer worker's clients.claim() reclaimed it. The PrecacheRoute above only
 * matches this build's manifest, so it falls through to here. Only immutable
 * hashed subresources may cross build boundaries; never the HTML shell.
 */
registerRoute(
  ({ request, url }) =>
    request.method === "GET" && url.origin === self.location.origin && ASSET_PATH_RE.test(url.pathname),
  async ({ request }) => {
    const precacheNames = (await caches.keys()).filter(
      (name) => name.startsWith("workbox-precache-") && name !== PRECACHE_CACHE_NAME
    )
    for (const name of precacheNames) {
      const cache = await caches.open(name)
      const match = await cache.match(request)
      if (match && !/^text\/html(?:;|$)/i.test(match.headers.get("Content-Type") ?? "")) return match
    }
    return fetch(request)
  }
)

async function isPrecacheComplete(): Promise<boolean> {
  const expected = [...precacheController.getURLsToCacheKeys().values()]
  if (!precacheController.getCacheKeyForURL("/index.html") || expected.length === 0) return false
  const cache = await caches.open(PRECACHE_CACHE_NAME)
  const present = new Set((await cache.keys()).map((request) => request.url))
  return expected.every((key) => present.has(key))
}

function replyToClient(client: Client | MessagePort | ServiceWorker | null, message: unknown): void {
  if (!client) return
  if ("postMessage" in client) {
    client.postMessage(message)
  }
}

self.addEventListener("message", (event) => {
  const data = event.data as { type?: string; buildId?: string } | undefined
  if (!data?.type) return

  if (data.type === SW_MSG_SKIP_WAITING) {
    event.waitUntil(isPrecacheComplete().then((ready) => (ready ? self.skipWaiting() : undefined)))
    return
  }

  if (data.type === SW_MSG_QUERY_STATUS) {
    event.waitUntil(
      (async () => {
        const ready = await isPrecacheComplete().catch(() => false)
        replyToClient(event.ports?.[0] ?? event.source, {
          type: SW_MSG_STATUS_REPLY,
          version: BUILD_VERSION,
          buildId: BUILD_ID,
          ready,
        })
      })()
    )
    return
  }

  if (data.type === SW_MSG_APPLY_UPDATE) {
    event.waitUntil(
      (async () => {
        if (data.buildId !== BUILD_ID) return
        const ready = await isPrecacheComplete()
        if (!ready) return
        await self.skipWaiting()
      })()
    )
    return
  }

  if (data.type === SW_MSG_QUEUE_BOOTSTRAP_SYNC) {
    const payload = data as {
      workspaceId?: string
      streamId?: string | null
      messageId?: string | null
      workosUserId?: string | null
    }
    if (!payload.workspaceId) return
    event.waitUntil(
      queueBootstrapSync(
        {
          workspaceId: payload.workspaceId,
          streamId: payload.streamId ?? null,
          messageId: payload.messageId ?? null,
          workosUserId: payload.workosUserId ?? null,
        },
        self.registration
      )
    )
    return
  }

  if (data.type === SW_MSG_CLEAR_NOTIFICATIONS) {
    const streamId = (data as { streamId?: string }).streamId
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
    return
  }

  if (data.type === SW_MSG_QUERY_BUILD) {
    event.waitUntil(
      (async () => {
        replyToClient(event.ports?.[0] ?? event.source, {
          type: SW_MSG_BUILD_REPLY,
          buildId: BUILD_ID,
        })
      })()
    )
    return
  }

  if (data.type === SW_MSG_RUN_GC) {
    event.waitUntil(
      runConservativeGc().then(() => {
        event.ports?.[0]?.postMessage({ type: SW_MSG_GC_REPLY })
      })
    )
  }
})

/**
 * Conservative GC: only delete prior-generation precaches after proving that
 * every same-origin window client is on a known generation. A client that does
 * not reply is treated as unknown/sleeping and aborts deletion. We re-query the
 * client set immediately before deleting to close navigation/opening races.
 */
async function runConservativeGc(): Promise<void> {
  // Serialize install/cleanup with a Web Lock when available. If locks are not
  // supported we conservatively defer and log a diagnostic rather than risk
  // racing a reinstall with cleanup.
  if (!self.navigator.locks) {
    console.warn("[SW] Web Locks unsupported; deferring precache GC")
    return
  }
  try {
    await self.navigator.locks.request(PRECACHE_LOCK, gcWithKnownClients)
  } catch (error) {
    console.warn("[SW] Precache cleanup deferred", error)
  }
}

async function gcWithKnownClients(): Promise<void> {
  if (self.registration.installing) return
  const active = self.registration.active
  const waiting = self.registration.waiting
  if (
    !active ||
    active.state !== "activated" ||
    (await queryBuild(active, SW_MSG_QUERY_STATUS, SW_MSG_STATUS_REPLY)) !== BUILD_ID
  )
    return
  const candidates = (await caches.keys()).filter(
    (name) => name.startsWith("workbox-precache-") && name !== PRECACHE_CACHE_NAME
  )

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const sameOriginClients = clients.filter((client) => new URL(client.url).origin === self.location.origin)

  const knownBuildIds = new Set<string>([BUILD_ID])
  if (waiting) {
    const waitingBuildId = await queryBuild(waiting, SW_MSG_QUERY_STATUS, SW_MSG_STATUS_REPLY)
    if (!waitingBuildId) return
    knownBuildIds.add(waitingBuildId)
  }
  const replies = await Promise.all(
    sameOriginClients.map((client) => queryBuild(client, SW_MSG_QUERY_BUILD, SW_MSG_BUILD_REPLY))
  )
  for (const reply of replies) {
    if (!reply) return // Unknown/sleeping/nonreply client: abort.
    knownBuildIds.add(reply)
  }

  // Re-scan before deleting to close races with a tab that opened or navigated
  // mid-scan. Compare full client id sets, not just counts.
  const clientsAgain = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const sameOriginAgain = clientsAgain.filter((client) => new URL(client.url).origin === self.location.origin)
  const ids = sameOriginClients.map((client) => client.id).sort()
  const idsAgain = sameOriginAgain.map((client) => client.id).sort()
  if (ids.length !== idsAgain.length || !ids.every((id, i) => id === idsAgain[i])) return

  // Re-check for a new generation that started installing/waiting during the
  // client survey above (which awaits up to 1500ms per client). Without this,
  // an incoming install or a rollback reusing a previously-known buildId could
  // have its cache deleted out from under it.
  if (self.registration.active !== active || self.registration.installing || self.registration.waiting !== waiting)
    return

  const deletable = candidates.filter((name) => {
    if (!name.startsWith("workbox-precache-")) return false
    const candidateBuildId = name.slice("workbox-precache-".length)
    return candidateBuildId !== BUILD_ID && !knownBuildIds.has(candidateBuildId)
  })

  // Preserve all non-precache user caches (push bootstrap, share target,
  // pending sync, avatars, presence).
  await Promise.all(deletable.map((name) => caches.delete(name)))
}

function queryBuild(target: Client | ServiceWorker, requestType: string, replyType: string): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const finish = (buildId: string | null) => {
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      resolve(buildId)
    }
    const timer = setTimeout(() => finish(null), 1500)
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: string; buildId?: string; ready?: boolean } | undefined
      const usable =
        data?.type === replyType &&
        typeof data.buildId === "string" &&
        data.buildId.length > 0 &&
        (replyType !== SW_MSG_STATUS_REPLY || data.ready === true)
      finish(usable ? data.buildId! : null)
    }
    try {
      target.postMessage({ type: requestType }, [channel.port2])
    } catch {
      finish(null)
    }
  })
}

async function trimAvatarCache(cache: Cache): Promise<void> {
  const keys = await cache.keys()
  if (keys.length <= AVATAR_CACHE_MAX_ENTRIES) return
  await Promise.all(keys.slice(0, keys.length - AVATAR_CACHE_MAX_ENTRIES).map((key) => cache.delete(key)))
}

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
      await runBootstrapSync(target)
      await cache.delete(PENDING_SYNC_KEY)
    })()
  )
}) as EventListener)

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

        await cache.put(
          new Request("/_share/meta"),
          new Response(JSON.stringify({ title, text, url: sharedUrl, fileCount: storedFileCount }))
        )
      } catch {
        // Best-effort stash.
      }

      return Response.redirect("/share", 303)
    })()
  )
})

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (!WORKSPACE_BOOTSTRAP_PATH_RE.test(url.pathname)) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(PUSH_BOOTSTRAP_CACHE)
      return respondToBootstrapRequest(event.request, cache, (req) => fetch(req))
    })()
  )
})

/** Structured push payload — display text is formatted here, not on the backend (INV-46). */
interface PushData {
  workspaceId?: string
  workosUserId?: string
  streamId?: string
  messageId?: string
  conversationId?: string
  activityType?: string
  contentPreview?: string
  streamName?: string
  authorName?: string
  emoji?: string
  messages?: Array<{ authorName?: string; contentPreview?: string; emoji?: string }>
  action?: "clear" | "session_expired"
  kind?: "test" | "saved_reminder" | "rewrap_needed" | "call_ring" | "call_ring_cancel" | "missed_call"
  attemptId?: string
  callId?: string
  inviterName?: string
  outcome?: RingCancelData["outcome"]
  mode?: string
  expiresAt?: string
}

self.addEventListener("push", (event) => {
  if (!event.data) return

  let data: PushData
  try {
    const payload = event.data.json() as { data?: PushData }
    data = payload.data ?? {}
  } catch {
    data = {}
  }

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

  if (data.kind === "rewrap_needed") {
    event.waitUntil(
      self.registration.showNotification("Your assistant is waiting", {
        body: "Unlock Threa to let your assistant reply in your encrypted scratchpad.",
        icon: "/threa-logo-192.png",
        badge: "/threa-logo-192.png",
        tag: data.streamId ? `rewrap:${data.streamId}` : "rewrap",
        renotify: true,
        vibrate: THREA_VIBRATION_PATTERN,
        data: { ...data, kind: "rewrap_needed" },
      } as ExtendedNotificationOptions)
    )
    return
  }

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

  const fmt = import("./lib/sw-notification-format")
  const tag = data.streamId ? resolveTag(data.streamId, data.activityType) : "threa-notification"

  event.waitUntil(
    Promise.all([fmt, self.clients.matchAll({ type: "window", includeUncontrolled: true }), readVisibleStreams()]).then(
      async ([{ appendMessage, formatTitle, formatBody, isViewingStream }, clients, visibleStreams]) => {
        const focusedClients = clients.filter((c) => c.focused && new URL(c.url).origin === self.location.origin)
        const viewingThisStream =
          focusedClients.some((c) => isViewingStream(c.url, data.workspaceId, data.streamId)) ||
          (focusedClients.length > 0 && !!data.streamId && visibleStreams.has(data.streamId))
        if (viewingThisStream && (await isDevicePresent())) return

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
          renotify: true,
          vibrate: THREA_VIBRATION_PATTERN,
        }

        for (const n of existing) n.close()

        await self.registration.showNotification(title, options)

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
    targetUrl = data.streamId
      ? `/w/${data.workspaceId}/s/${data.streamId}?call=${data.callId}`
      : `/w/${data.workspaceId}?call=${data.callId}`
  } else if (data?.workspaceId && data?.conversationId) {
    const params = new URLSearchParams({ panel: `conv:${data.conversationId}` })
    if (data.messageId) params.set("m", data.messageId)
    targetUrl = `/w/${data.workspaceId}/board?${params.toString()}`
  } else if (data?.workspaceId && data?.streamId) {
    targetUrl = data.messageId
      ? `/w/${data.workspaceId}/s/${data.streamId}?m=${data.messageId}`
      : `/w/${data.workspaceId}/s/${data.streamId}`
  } else if (data?.workspaceId && data.kind === "saved_reminder") {
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
      await self.clients.openWindow(absoluteUrl)
    })
  )
})

self.addEventListener("pushsubscriptionchange", (event) => {
  const evt = event as ExtendableEvent & {
    oldSubscription?: PushSubscription
    newSubscription?: PushSubscription
  }

  evt.waitUntil(
    (async () => {
      try {
        const oldSub = evt.oldSubscription
        const applicationServerKey = oldSub?.options.applicationServerKey
        if (!applicationServerKey && !evt.newSubscription) return

        const newSub =
          evt.newSubscription ??
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          }))

        if (!newSub) return

        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
        if (clients.length === 0) return

        for (const client of clients) {
          client.postMessage({
            type: SW_MSG_SUBSCRIPTION_CHANGED,
            subscription: newSub.toJSON(),
          })
        }
      } catch {
        // Swallow — the hook will re-subscribe on next app load.
      }
    })()
  )
})
