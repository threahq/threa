/**
 * Whether a string is a usable IANA timezone identifier (e.g. "Europe/Stockholm").
 *
 * Shared across services because a zone accepted by one and rejected by another
 * strands work between them: the control plane enqueues a workspace's timezone
 * for its region to store, and a value that only fails at the far end leaves the
 * workspace registered but unprovisioned.
 */
export function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}
