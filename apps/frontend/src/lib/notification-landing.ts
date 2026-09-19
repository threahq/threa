/**
 * The app's half of a notification tap: claim the destination the worker
 * stashed and go there.
 *
 * Three entry points claim — boot, return-to-foreground, and the worker's
 * message — because any one of them can be the only one that fires. They run
 * one at a time through a single chain, so the loser reads an empty stash and
 * returns instead of pushing a second history entry for the same tap.
 */

import { isSameOriginPath, takeNotificationTarget, type NotificationTarget } from "./notification-target-storage"
import { setNotificationIntent } from "./notification-intent"

export interface NotificationLandingDeps {
  navigate: (url: string, options: { replace: boolean }) => Promise<unknown> | unknown
  /** The path+search the viewer is on now. */
  currentUrl: () => string
  /** False on a launch, where the claim replaces `start_url` instead of stacking on it. */
  hasHistoryBeneath: () => boolean
}

async function claim(deps: NotificationLandingDeps, fallback: NotificationTarget | undefined): Promise<void> {
  const target = (await takeNotificationTarget()) ?? fallback
  if (!target || !isSameOriginPath(target.url)) return
  if (target.url === deps.currentUrl()) return
  // Set the notification's intended recipient *before* navigating so the
  // freshly-mounted WorkspaceLayout's switch hook sees it. The hook flips the
  // active account in place if the tap landed under a different one.
  const workspaceMatch = /^\/w\/([^/]+)/.exec(target.url)
  if (target.workosUserId && workspaceMatch) {
    setNotificationIntent(workspaceMatch[1], target.workosUserId)
  }
  // A launch claim replaces `start_url`: a push there would leave a dead entry
  // that `RootRedirect` bounces straight back, and would hide the launch from
  // `useRebuildLaunchAncestors`, which only rebuilds under an untouched one.
  const replace = !deps.hasHistoryBeneath()
  await deps.navigate(target.url, { replace })
  // `RootRedirect`'s own redirect aborts a navigation still resolving its lazy
  // route, and the data router reports that abort as an ordinary completion.
  // The stash is already consumed, so the retry is the only thing left.
  if (deps.currentUrl() === target.url) return
  await deps.navigate(target.url, { replace })
}

/**
 * A claim function bound to these deps. Failures are logged and end there: a
 * rejection left in the chain would silently disable every later tap.
 */
export function createNotificationLanding(
  deps: NotificationLandingDeps
): (fallback?: NotificationTarget) => Promise<void> {
  let landing: Promise<void> = Promise.resolve()
  return (fallback?: NotificationTarget) => {
    const run = () => claim(deps, fallback)
    landing = landing.then(run, run).catch((error: unknown) => {
      console.warn("[notify] Could not land on the tapped notification's destination:", error)
    })
    return landing
  }
}
