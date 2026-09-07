/** Posted to the focused window when user clicks a notification. */
export const SW_MSG_NOTIFICATION_CLICK = "NOTIFICATION_CLICK"

/** Posted to all windows when the push subscription is rotated by the browser. */
export const SW_MSG_SUBSCRIPTION_CHANGED = "PUSH_SUBSCRIPTION_CHANGED"

/** Posted from the app to the SW to dismiss notifications for a stream the user is viewing. */
export const SW_MSG_CLEAR_NOTIFICATIONS = "CLEAR_NOTIFICATIONS"

/**
 * Posted from the app to the SW to queue a background-sync prefetch of workspace
 * and (optionally) stream bootstrap. The SW persists the target and registers a
 * Background Sync so the prefetch survives SW termination and retries on
 * network failure. On browsers without Background Sync (or when `register()`
 * throws), `queueBootstrapSync` falls back to running the prefetch inline once
 * — there is no retry on inline-fallback failures, so callers that need
 * guaranteed delivery should not rely on the message alone.
 */
export const SW_MSG_QUEUE_BOOTSTRAP_SYNC = "QUEUE_BOOTSTRAP_SYNC"

/**
 * Posted from the app to a waiting SW to activate it after the user accepts the
 * update toast. New workers stay parked until this message so an open tab keeps
 * the worker and precache that match its running JS.
 *
 * Legacy shape: { type: SW_MSG_SKIP_WAITING }. The new worker still honors it so
 * an old page upgrading into a new worker can activate it.
 */
export const SW_MSG_SKIP_WAITING = "SKIP_WAITING"

/**
 * Posted from the app to the SW to request the worker's build identity and
 * whether its precache is complete. The reply is sent over the MessageChannel
 * port included in the message.
 */
export const SW_MSG_QUERY_STATUS = "QUERY_STATUS"

/** Reply to SW_MSG_QUERY_STATUS. Carries the worker's build metadata. */
export const SW_MSG_STATUS_REPLY = "STATUS_REPLY"

/**
 * Posted from the app to a waiting SW to activate a specific build. The worker
 * validates the requested buildId against its own artifact identity and only
 * calls skipWaiting after verifying its precache is complete.
 */
export const SW_MSG_APPLY_UPDATE = "APPLY_UPDATE"

/**
 * Posted from the SW to all clients to ask which build they are running. Used
 * during conservative GC: if any client does not reply, old precaches are not
 * deleted.
 */
export const SW_MSG_QUERY_BUILD = "QUERY_BUILD"

/** Reply to SW_MSG_QUERY_BUILD. Carries the client's current build id. */
export const SW_MSG_BUILD_REPLY = "BUILD_REPLY"

/**
 * Posted from the app to the SW to request a conservative GC pass. The SW will
 * only delete prior-generation precaches after proving all same-origin clients
 * are on a known current generation.
 */
export const SW_MSG_RUN_GC = "RUN_GC"

/** Cache name used by the SW to stash share-target POST data (files + text) for the app to read. */
export const SHARE_TARGET_CACHE = "share-target"
