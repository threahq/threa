/**
 * The app's half of a notification tap: claim the destination the worker
 * stashed and go there.
 *
 * Several entry points claim — boot, every return-to-foreground signal, and the
 * worker's message — because any one of them can be the only one that fires.
 * They run one at a time through a single chain, so the loser reads an empty
 * stash and returns instead of pushing a second history entry for the same tap.
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
  // Before the same-screen return below: a push for a parked account can name the
  // stream already open, and the flip is the whole point of that tap. The
  // freshly-mounted WorkspaceLayout's switch hook reads the intent on mount and
  // on every later set, and flips the active account in place.
  const workspaceMatch = /^\/w\/([^/]+)/.exec(target.url)
  if (target.workosUserId && workspaceMatch) {
    setNotificationIntent(workspaceMatch[1], target.workosUserId)
  }
  if (target.url === deps.currentUrl()) return
  // A launch claim replaces `start_url`: a push there would leave a dead entry
  // that `RootRedirect` bounces straight back, and would hide the launch from
  // `useRebuildLaunchAncestors`, which only rebuilds under an untouched one.
  const replace = !deps.hasHistoryBeneath()
  await deps.navigate(target.url, { replace })
  // `RootRedirect`'s own redirect aborts a navigation still resolving its lazy
  // route, and the data router reports that abort as an ordinary completion.
  // The stash is already consumed, so the retry is the only thing left. It always
  // replaces: a target the app deliberately redirects away from (`/w/:id` lands on
  // a stream) reaches here too, and pushing again would stack a second entry on
  // the same place.
  if (deps.currentUrl() === target.url) return
  await deps.navigate(target.url, { replace: true })
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
