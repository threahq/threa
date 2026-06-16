/**
 * Short-lived, device-local record of drafts this device just resolved-on-send,
 * so neither an in-flight local save nor an inbound echo/bootstrap can resurrect
 * a just-sent draft — the "I sent a message and it came back into the composer,
 * so I sent it again" race.
 *
 * Two keys, because the two resurrection paths reach for different identifiers:
 *
 *  - **by scope** — guards the LOCAL stale-save race. A debounced `saveDraft`
 *    scheduled by the last keystroke can fire around the send teardown; if it
 *    runs after the loaded pointer is cleared it would create a brand-new draft
 *    (fresh id) holding the just-sent content and re-point the composer at it.
 *    A re-created draft has a new id, so only the scope is stable here.
 *
 *  - **by draft id + version** — guards the INBOUND echo/bootstrap race. The
 *    `draft:upserted` echo of our own last push, or a reconnect bootstrap that
 *    re-seeds the still-present server row before the `resolve_draft` op drains,
 *    carries the resolved id. We drop it at or below the version we resolved at;
 *    a genuinely newer version from another device is `>` that and still survives
 *    as a stash entry (the no-loss rule — INV: drafts roam, only duplicates lost).
 *
 * In-memory (module-local, mirroring the draft-store cache pattern) with a short
 * TTL: the window only needs to cover the debounce + send round-trip and an
 * in-flight echo / reconnect bootstrap, not a full page reload (a rarer case).
 */

const TTL_MS = 60_000

const scopeResolvedUntil = new Map<string, number>()
const draftResolvedVersion = new Map<string, { version: number; expiresAt: number }>()

function expired(expiresAt: number): boolean {
  return expiresAt <= Date.now()
}

/** Mark a scope as just resolved-on-send (drops a stale local save's re-create). */
export function markScopeResolved(scope: string): void {
  scopeResolvedUntil.set(scope, Date.now() + TTL_MS)
}

/** True while a scope is within its post-send window (and the user hasn't typed since). */
export function isScopeRecentlyResolved(scope: string): boolean {
  const until = scopeResolvedUntil.get(scope)
  if (until === undefined) return false
  if (expired(until)) {
    scopeResolvedUntil.delete(scope)
    return false
  }
  return true
}

/** Lift the scope guard — the user engaged the composer again, so a save is real. */
export function clearScopeResolved(scope: string): void {
  scopeResolvedUntil.delete(scope)
}

/** Remember a resolved draft's (id, version) so its inbound echo can be dropped. */
export function markDraftResolved(draftId: string, version: number): void {
  draftResolvedVersion.set(draftId, { version, expiresAt: Date.now() + TTL_MS })
}

/**
 * True when an inbound draft row is an echo/re-seed of a draft this device just
 * resolved (same id, at or below the resolved version). A strictly newer version
 * is a real edit from elsewhere and is NOT suppressed.
 */
export function isResolvedDraftEcho(draftId: string, version: number): boolean {
  const rec = draftResolvedVersion.get(draftId)
  if (rec === undefined) return false
  if (expired(rec.expiresAt)) {
    draftResolvedVersion.delete(draftId)
    return false
  }
  return version <= rec.version
}

/** Test-only reset of the in-memory guard between cases. */
export function resetDraftResolutionGuard(): void {
  scopeResolvedUntil.clear()
  draftResolvedVersion.clear()
}
