/**
 * Format an ISO timestamp using the backoffice's en-GB convention. Single
 * source of truth so workspace details, members, and invitations all render
 * timestamps the same way (INV-35).
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Date-only variant of {@link formatDateTime} for list rows and previews where
 * the time-of-day would be noise. Same en-GB convention so dates read the same
 * across the backoffice (INV-35).
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  })
}
