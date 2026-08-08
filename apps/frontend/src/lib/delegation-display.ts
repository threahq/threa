import { DELEGATION_TERMINAL_STATUSES, type DelegationReopenReason, type DelegationStatus } from "@threa/types"

/** Display labels for delegation statuses shared by first-party surfaces. */
export const DELEGATION_STATUS_LABEL: Record<DelegationStatus, string> = {
  open: "Open",
  claimed: "Claimed",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Claim expired",
}

export const DELEGATION_REOPEN_REASON_LABEL: Record<DelegationReopenReason, string> = {
  claim_expired: "Claim expired · Open again",
  claim_released: "Claim released · Open again",
  requeued: "Requeued · Open",
}

export const DELEGATION_TERMINAL: ReadonlySet<DelegationStatus> = new Set(DELEGATION_TERMINAL_STATUSES)

export function delegationAvailabilityLabel(status: DelegationStatus, reason?: DelegationReopenReason): string {
  return status === "open" && reason ? DELEGATION_REOPEN_REASON_LABEL[reason] : DELEGATION_STATUS_LABEL[status]
}

export function delegationStatusPillClass(status: DelegationStatus): string {
  switch (status) {
    case "open":
      return "bg-sky-500/15 text-sky-600 dark:text-sky-400"
    case "expired":
      return "bg-primary/15 text-primary"
    case "claimed":
    case "running":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400"
    case "completed":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
    case "failed":
      return "bg-red-500/15 text-red-600 dark:text-red-400"
    case "cancelled":
      return "bg-muted text-muted-foreground"
  }
}
