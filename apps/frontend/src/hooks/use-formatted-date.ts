import { useMemo } from "react"
import { usePreferences } from "@/contexts"
import { formatDisplayDate, formatTime, formatRelativeTime, formatFullDateTime } from "@/lib/dates"

/** Date formatting functions bound to the current user's preferences. */
export function useFormattedDate() {
  const { preferences } = usePreferences()

  return useMemo(
    () => ({
      /**
       * Format a date according to user preferences.
       * @returns Formatted date string (e.g., "2025-01-15", "15/01/2025", or "01/15/2025")
       */
      formatDate: (date: Date) => formatDisplayDate(date, preferences ?? undefined),

      /**
       * Format time according to user preferences.
       * @returns Formatted time string (e.g., "14:30" or "2:30 PM")
       */
      formatTime: (date: Date) => formatTime(date, preferences ?? undefined),

      /**
       * Format a date relative to now using user time preferences.
       * Verbose (default): "yesterday 14:30", "Monday 2:30 PM" — includes time.
       * Terse: "now", "2m ago", "5h ago", "yesterday" — compact, no time.
       */
      formatRelative: (date: Date, now?: Date, options?: { terse?: boolean }) =>
        formatRelativeTime(date, now, preferences ?? undefined, options),

      /** Format a full date-time for tooltips using user preferences. */
      formatFull: (date: Date) => formatFullDateTime(date, preferences ?? undefined),
    }),
    [preferences]
  )
}
