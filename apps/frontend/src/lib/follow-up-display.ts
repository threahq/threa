import { FOLLOW_UP_TERMINAL_STATUSES, type FollowUpStatus } from "@threahq/types"

/** Display labels for follow-up statuses — shared by the "In this stream" panel and the outcomes surfaces. */
export const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string> = {
  pending: "Scheduled",
  fired: "Ran",
  cancelled: "Cancelled",
  failed: "Failed",
}

export const FOLLOW_UP_TERMINAL: ReadonlySet<FollowUpStatus> = new Set(FOLLOW_UP_TERMINAL_STATUSES)

/**
 * Pill classes for a follow-up status badge. Same vocabulary as delegations:
 * still-to-happen states carry colour, ended states recede into muted.
 */
export function followUpStatusPillClass(status: FollowUpStatus): string {
  switch (status) {
    case "pending":
      return "bg-sky-500/15 text-sky-600 dark:text-sky-400"
    case "fired":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
    case "failed":
      return "bg-red-500/15 text-red-600 dark:text-red-400"
    case "cancelled":
      return "bg-muted text-muted-foreground"
  }
}
