import { NOTIFICATION_CONFIG } from "@threahq/types"
import type { StreamType, NotificationLevel } from "@threahq/types"

export { NOTIFICATION_CONFIG }

export function isAllowedLevel(streamType: StreamType, level: NotificationLevel): boolean {
  return NOTIFICATION_CONFIG[streamType].allowedLevels.includes(level)
}

export function getDefaultLevel(streamType: StreamType): NotificationLevel {
  return NOTIFICATION_CONFIG[streamType].defaultLevel
}

/**
 * Resolve notification level from an explicit level and stream type.
 * Does NOT consider ancestor inheritance — use the resolver for that.
 */
export function getEffectiveLevel(
  explicitLevel: NotificationLevel | null | undefined,
  streamType: StreamType
): NotificationLevel {
  return explicitLevel ?? getDefaultLevel(streamType)
}
