/**
 * The inline amber banner shown when a concurrent admin's commit lands while the
 * form holds unsynced edits (INV-63 — nothing lost silently, no toast). Shared by
 * both persona editors (built-in and custom) and both conflict entry points (a
 * Save 409 and a broadcast-driven baseline advance). "Load their changes" drops
 * the local edits and adopts the other admin's version as the starting point.
 */
export function PersonaConflictBanner({ onLoadTheirs }: { onLoadTheirs: () => void }) {
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      Someone else updated this persona while you were editing. Save again to overwrite their version, or{" "}
      <button type="button" className="font-medium underline underline-offset-2" onClick={onLoadTheirs}>
        load their changes
      </button>{" "}
      to start from it.
    </p>
  )
}
