import type { usePushNotifications } from "./use-push-notifications"

export type PushDeviceState = "unsupported" | "blocked" | "off" | "on" | "subscribing" | "server-off" | "error"

/** Where push stands on this device, for every surface that explains it. */
export function resolvePushDeviceState(push: ReturnType<typeof usePushNotifications>): PushDeviceState {
  if (push.permission === "unsupported") return "unsupported"
  if (push.permission === "denied") return "blocked"
  if (push.permission === "default") return "off"
  if (push.isSubscribed) return "on"
  if (push.optedOut) return "off"
  if (push.pushDisabledOnServer) return "server-off"
  if (push.status === "error") return "error"
  // Granted with nothing else set: either subscribing, or idle just before the
  // auto-subscribe effect starts. Both are on their way to on.
  return "subscribing"
}
