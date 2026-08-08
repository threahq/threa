/** Why a restore did not happen. Every guard returns one; none is silent (INV-11). */
export type DraftRestoreRefusal = "missing" | "host-ineligible" | "raced"

export type DraftRestoreResult = { ok: true } | { ok: false; reason: DraftRestoreRefusal }

/**
 * User-facing copy for a refused restore, shared by the picker and the `?stash=`
 * deep link so the two can't drift (INV-35). Each line names what happened to
 * the DRAFT, not which predicate failed — `host-ineligible` stays deliberately
 * general because it covers encrypted, archived and unresolvable alike, and
 * naming any one of them would be wrong most of the time.
 */
export const RESTORE_REFUSAL_MESSAGE: Record<DraftRestoreRefusal, string> = {
  missing: "That draft is no longer there.",
  "host-ineligible": "This stream can't hold that draft — it stays where it is.",
  raced: "That draft moved before it could be restored.",
}
