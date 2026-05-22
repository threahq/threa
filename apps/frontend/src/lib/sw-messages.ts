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
 * Posted from the app to the SW (the controlling worker) to serve the *next*
 * navigation from the network instead of the cache-first precache shell. Used by
 * the "new version" reload so the reload lands on the freshly-deployed build
 * rather than the old build the current SW precached.
 */
export const SW_MSG_RELOAD_FRESH = "RELOAD_FRESH"

/** Cache name used by the SW to stash share-target POST data (files + text) for the app to read. */
export const SHARE_TARGET_CACHE = "share-target"
