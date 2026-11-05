const SQLITE_MARKS_PREFIX = "sqliteMarks:"

/**
 * Builds that mirrored IndexedDB into SQLite recorded each writer of a store
 * in the store's marks store. Nothing writes them any more; the schema keeps
 * them, and an import clears them, so such a build never misreads what SQLite holds.
 */
export function sqliteMarksStore(store: string): string {
  return SQLITE_MARKS_PREFIX + store
}

export function isSqliteMarksStore(name: string): boolean {
  return name.startsWith(SQLITE_MARKS_PREFIX)
}

/** Dexie schema for the marks stores of `stores`, keyed by writer. */
export function sqliteMarksSchema(stores: readonly string[]): Record<string, string> {
  return Object.fromEntries(stores.map((store) => [sqliteMarksStore(store), "writer"]))
}

/** Named an IndexedDB's lifetime for builds that mirrored it; kept in the schema like the marks stores. */
export const SQLITE_INCARNATION_STORE = "sqliteIncarnation"

export function mirrorChannelName(idbName: string): string {
  return `threa-sqlite-mirror:${idbName}`
}
