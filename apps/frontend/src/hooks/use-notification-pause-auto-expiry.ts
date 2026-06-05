import { useEffect } from "react"
import type { UserNotificationPauseFields } from "@threa/types"
import { useResumeNotifications } from "./use-workspaces"

// setTimeout truncates delays past its signed-32-bit ceiling, firing almost
// immediately instead — so for pauses further out than this we rely on
// render-time masking and the next mount's check rather than a bogus timer.
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Resumes the current user's notifications when a manual *timed* pause lapses,
 * authoritatively, so the change broadcasts to the whole workspace. Mirrors
 * `useStatusAutoExpiry`: render-time masking (`resolveNotificationPause`) hides
 * a lapsed pause locally, but only the owner's session can persist the clear —
 * without this, an idle client would keep showing a lapsed do-not-disturb badge
 * to other viewers until some unrelated re-render.
 *
 * No-ops for an indefinite pause (never lapses), for a status-linked pause
 * (which clears with its status, not here), and for pauses too far out for a
 * single timer.
 */
export function useNotificationPauseAutoExpiry(
  workspaceId: string,
  currentUser: Partial<UserNotificationPauseFields> | null
): void {
  const resume = useResumeNotifications(workspaceId)
  const { mutate } = resume

  // Only a timed manual pause needs an authoritative clear. `mapRowToUser`
  // already masks an elapsed `notificationsPausedUntil` to null, so any value
  // here is in the future; schedule a one-shot resume for it.
  const pausedUntil =
    currentUser && !currentUser.notificationsPausedIndefinitely ? (currentUser.notificationsPausedUntil ?? null) : null

  useEffect(() => {
    if (!pausedUntil) return
    const delay = new Date(pausedUntil).getTime() - Date.now()
    if (delay <= 0 || delay > MAX_TIMEOUT_MS) return
    const timer = setTimeout(() => mutate(undefined, { onError: () => {} }), delay)
    return () => clearTimeout(timer)
  }, [pausedUntil, mutate])
}
