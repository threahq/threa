import { NOTIFICATION_CONFIG, type NotificationLevel, type StreamType } from "./constants"

/** How many ancestors a stream with no level of its own looks through for one to follow. */
export const NOTIFICATION_INHERIT_DEPTH = 2

/** What an ancestor's explicit level carries to a stream below it; null carries nothing and ends the walk. */
const CARRIED_LEVEL: Record<NotificationLevel, NotificationLevel | null> = {
  everything: "activity",
  activity: null,
  mentions: null,
  muted: "muted",
}

export interface InheritedNotificationLevel<A> {
  level: NotificationLevel
  /** The ancestor whose level decided it, or null when the stream type's default applies. */
  from: A | null
}

/**
 * The level a stream with no level of its own gets. The nearest ancestor with
 * an explicit level decides: Muted carries as Muted, Everything as Activity,
 * and anything else, or a level the stream type doesn't allow, leaves the
 * stream type's default. `ancestors` run nearest first, at most
 * `NOTIFICATION_INHERIT_DEPTH` of them.
 */
export function resolveInheritedNotificationLevel<A extends { level: NotificationLevel | null | undefined }>(
  streamType: StreamType,
  ancestors: readonly A[]
): InheritedNotificationLevel<A> {
  const { defaultLevel, allowedLevels } = NOTIFICATION_CONFIG[streamType]
  const decider = ancestors.find((ancestor) => ancestor.level)
  const carried = decider?.level ? CARRIED_LEVEL[decider.level] : null
  if (decider && carried && allowedLevels.includes(carried)) return { level: carried, from: decider }
  return { level: defaultLevel, from: null }
}
