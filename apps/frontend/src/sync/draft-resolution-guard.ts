/**
 * Device-local guards that stop a just-sent draft from being resurrected, by
 * either of the two paths that can do it after a resolve-on-send.
 *
 * 1. **Local stale-save race — a monotonic per-scope resolve sequence.** When a
 *    message is sent, the editor is cleared and the draft + composer pointer are
 *    torn down asynchronously (`resolveLoadedDraft`, fire-and-forget). A debounced
 *    `saveDraft` armed by the last keystroke can fire around that teardown;
 *    `upsertLoadedDraft` re-reads the loaded pointer and, finding none, would
 *    create a fresh draft with the just-sent content and re-point the composer at
 *    it. The save records the scope's resolve seq when it starts and threads it
 *    into the create branch; if a resolve advanced the seq in between, the save is
 *    stale and its create is dropped. Only the debounced save opts in — every
 *    other create path (share-target, attachments, DM-scope migration, a fresh
 *    first keystroke) passes no seq and is never affected. The seq is a plain
 *    counter (no TTL): it only has to outlive an in-flight save, and comparing two
 *    integers needs no expiry.
 *
 * 2. **Inbound echo race — a short-lived `(draftId, version)` tombstone.** The
 *    `draft:upserted` echo of our own last push, or a reconnect bootstrap that
 *    re-seeds the still-present server row before the `resolve_draft` op drains,
 *    would re-create the draft as a stash entry. We remember the resolved
 *    `(id, version)` and drop inbound rows at or below it; a strictly newer
 *    version is a real edit from another device and still applies (no loss). This
 *    one is TTL'd because its window is "how long until the echo/reconnect lands",
 *    not tied to the debounce.
 */

const scopeResolveSeq = new Map<string, number>()

/** Bump a scope's resolve sequence — called when a draft is resolved-on-send. */
export function recordScopeResolved(scope: string): void {
  scopeResolveSeq.set(scope, (scopeResolveSeq.get(scope) ?? 0) + 1)
}

/** Current resolve sequence for a scope (0 if never resolved). */
export function getScopeResolveSeq(scope: string): number {
  return scopeResolveSeq.get(scope) ?? 0
}

const ECHO_TTL_MS = 60_000

const draftResolvedVersion = new Map<string, { version: number; expiresAt: number }>()

/** Remember a resolved draft's (id, version) so its inbound echo can be dropped. */
export function markDraftResolved(draftId: string, version: number): void {
  draftResolvedVersion.set(draftId, { version, expiresAt: Date.now() + ECHO_TTL_MS })
}

/**
 * True when THIS device resolved-on-send the draft that just disappeared. The
 * discriminator a composer needs when its loaded pointer goes null: only a local
 * send marks an id here, so a null that is a remote `draft:deleted` or a
 * deliberate teardown (discard, stash, relocate, purge) reads false and must not
 * be treated as "another editor sent the row out from under me".
 */
export function wasDraftResolvedLocally(draftId: string): boolean {
  const rec = draftResolvedVersion.get(draftId)
  if (rec === undefined) return false
  if (rec.expiresAt <= Date.now()) {
    draftResolvedVersion.delete(draftId)
    return false
  }
  return true
}

/**
 * True when an inbound draft row is an echo/re-seed of a draft this device just
 * resolved (same id, at or below the resolved version). A strictly newer version
 * is a real edit from elsewhere and is NOT suppressed.
 */
export function isResolvedDraftEcho(draftId: string, version: number): boolean {
  const rec = draftResolvedVersion.get(draftId)
  if (rec === undefined) return false
  if (rec.expiresAt <= Date.now()) {
    draftResolvedVersion.delete(draftId)
    return false
  }
  return version <= rec.version
}

/**
 * 3. **Id migration — a device-local forwarding map.** A draft can be re-keyed
 *    underneath a live composer (`migrateLocalDraftId`: a server split ack, a
 *    remote-delete preserve). Anything holding the OLD id — an armed debounced
 *    save, an in-flight identity-addressed write — must land on the new row, not
 *    create an orphan copy of it. The migration is recorded synchronously so a
 *    save that captured the pre-migration id can follow it forward. Chains are
 *    followed (X → X′ → X″); the map is device-local and unbounded only in the
 *    number of migrations a session performs.
 */
const migratedDraftIds = new Map<string, string>()

/** Record that draft `oldId` was re-keyed to `newId`. */
export function markDraftMigrated(oldId: string, newId: string): void {
  if (oldId === newId) return
  migratedDraftIds.set(oldId, newId)
}

/**
 * Follow a draft id through any migrations recorded for it, returning the id the
 * row lives under now (the input itself when it never migrated). A cycle would
 * be a bug, so the walk is bounded by the map size rather than trusting it.
 */
export function resolveMigratedDraftId(draftId: string): string {
  let current = draftId
  for (let hops = 0; hops <= migratedDraftIds.size; hops++) {
    const next = migratedDraftIds.get(current)
    if (next === undefined) return current
    current = next
  }
  return current
}

/** Test-only reset of the in-memory guards between cases. */
export function resetDraftResolutionGuard(): void {
  scopeResolveSeq.clear()
  draftResolvedVersion.clear()
  migratedDraftIds.clear()
}
