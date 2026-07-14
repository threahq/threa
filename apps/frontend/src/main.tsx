import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { router } from "./routes"
import { SW_MSG_NOTIFICATION_CLICK, SW_MSG_SUBSCRIPTION_CHANGED } from "./lib/sw-messages"
import { setNotificationIntent } from "./lib/notification-intent"
import { hydrateCollapseCache } from "./lib/markdown/collapse-cache"
import { applyPersistedComposerHeight } from "./lib/composer-height-storage"
import { installCrashRecovery } from "./lib/crash-recovery"
import { currentAppInstalledAt } from "./lib/app-build"
// Side-effect import: attaches the live pointer listener and sets <html data-input>
// before first paint so the CSS reveal model (.reveal-*) is correct from the start.
import "./hooks/use-input-mode"
import "./index.css"

// Record at bundle startup rather than when App status opens, so this is the
// first time the installed build actually ran on the device.
currentAppInstalledAt()

// Catch uncaught errors that wedge the app after the PWA returns from the
// background (e.g. resuming after "Open in Firefox") and reload instead of
// leaving a dead window that needs a manual restart. Installed before React
// mounts so resume tracking is live from the first lifecycle transition.
installCrashRecovery()

// Apply the last-observed composer height to `:root` so the timeline scroll
// viewport starts roughly docked above the composer on first render. The
// composer's own ResizeObserver overwrites the variable on the editor zone once
// mounted.
applyPersistedComposerHeight()

navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type === SW_MSG_NOTIFICATION_CLICK && event.data.url) {
    // Client-side navigation preserves React tree, TanStack Query cache, and socket connection
    const url = event.data.url as string
    if (url.startsWith("/")) {
      // Stash the notification's intended recipient *before* navigating so the
      // freshly-mounted WorkspaceLayout's switch hook sees it. The hook flips
      // the active account in place if the click landed under a different one.
      const workosUserId = event.data.workosUserId as string | undefined
      const workspaceMatch = /^\/w\/([^/]+)/.exec(url)
      if (workosUserId && workspaceMatch) {
        setNotificationIntent(workspaceMatch[1], workosUserId)
      }
      router.navigate(url)
    }
  }
  if (event.data?.type === SW_MSG_SUBSCRIPTION_CHANGED) {
    // The push subscription was rotated by the browser. Dispatch a custom event
    // so the push notifications hook can re-register without a full page reload.
    window.dispatchEvent(new CustomEvent("pushsubscriptionchanged"))
  }
})

// Register as soon as the main bundle runs — before React effects that call
// `navigator.serviceWorker.ready` (push subscribe). Deferring to `window` "load"
// can delay activation until all subresources finish; a slow page then races the
// 15s push subscribe timeout. Google's SW guidance also recommends registering early.
// updateViaCache: 'none' forces a network byte-check of sw.js instead of HTTP cache.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((err) => {
    console.error("[SW] Registration failed — push and offline updates will not work:", err)
  })
}

// Migrate persisted markdown-block + link-preview collapse state from the
// legacy IndexedDB tables into the in-memory mirror — but do NOT block first
// paint on it. The synchronous localStorage hydrate at collapse-cache import
// time already populates the cache for anyone who has toggled a block before,
// so the common case needs nothing from this call. `hydrateCollapseCache()`
// only does real work — a cold `db.open()` + table read — for users whose
// state predates the localStorage mirror, and awaiting that put an IndexedDB
// open on the critical path ahead of first paint (including the IDB-cached
// content render) for no benefit. It calls `notify()` when it resolves, so
// `useSyncExternalStore` consumers re-render and collapse state heals a few ms
// after paint for that shrinking legacy cohort, instead of stalling every
// boot's first paint behind it.
void hydrateCollapseCache()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
