import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { router } from "./routes"
import { SW_MSG_NOTIFICATION_CLICK, SW_MSG_SUBSCRIPTION_CHANGED } from "./lib/sw-messages"
import { setNotificationIntent } from "./lib/notification-intent"
import { hydrateCollapseCache } from "./lib/markdown/collapse-cache"
import { applyPersistedComposerHeight } from "./lib/composer-height-storage"
import "./index.css"

// Apply the last-observed composer height to `:root` so the timeline's footer
// spacer paints at roughly the correct size on first render. The composer's
// own ResizeObserver overwrites the variable on the editor zone once mounted.
applyPersistedComposerHeight()

// Handle messages from the service worker
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

// Bulk-load persisted markdown-block + link-preview collapse state into the
// in-memory mirror before mounting React. Synchronous consumers
// (`useBlockCollapse`, `useLinkPreviewCollapse`) see the persisted choices on
// their first render, eliminating the post-mount resize cascade that Virtuoso
// otherwise compensates for by shifting sibling rows.
//
// We race hydration against a deadline: when IDB is healthy (the common case,
// ~5–20ms) the await returns almost immediately; the deadline only fires when
// `db.open()` itself is slow — cold-boot schema migrations, a contended IDB
// connection, or a multi-thousand-row collapse table. 500ms is the headroom
// we need to clear those cases without bailing too early; the previous 100ms
// cap was tight enough that returning users with large collapse tables would
// mount with an empty cache and then flip a previously-expanded long code
// block from its default collapsed clamp to fully expanded once the persisted
// override landed on the next render — the "mega jump" reported in prod.
// At the deadline we mount with whatever the cache holds; `hydrateCollapseCache`
// keeps running and `notify()` still wakes subscribers, so the cache heals
// even if the deadline fired.
const HYDRATION_CAP_MS = 500

const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function bootstrap() {
  await Promise.race([hydrateCollapseCache(), waitMs(HYDRATION_CAP_MS)])
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void bootstrap()
