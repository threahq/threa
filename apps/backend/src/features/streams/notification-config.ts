import { NOTIFICATION_CONFIG } from "@threahq/types"
import type { StreamType, NotificationLevel } from "@threahq/types"

export { NOTIFICATION_CONFIG }

export function isAllowedLevel(streamType: StreamType, level: NotificationLevel): boolean {
  return NOTIFICATION_CONFIG[streamType].allowedLevels.includes(level)
}
