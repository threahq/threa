import { getActiveDb, type ThreaDatabase } from "@/db"

/**
 * A module-level registry whose entries belong to the account database they
 * were built from.
 *
 * The shared Dexie registries (board rails, the thread index, the conversation
 * graph, board drafts, workspace tables) are keyed by a stream or workspace id
 * — ids two accounts genuinely share, because two accounts can be members of
 * the same workspace and read the same stream. Keyed by id alone, one account's
 * cached rows, names and draft snapshots are handed to the next one, and the
 * outgoing account's teardown timers and in-flight emissions land on the
 * replacement entry.
 *
 * Partitioning by the concrete `ThreaDatabase` instance closes both: an account
 * switch repoints the `db` proxy, so the next `acquire` opens a fresh partition
 * and reads nothing the previous account left behind, while the previous
 * account's callbacks keep resolving against their own captured partition.
 * Callers capture `database` and `entry` and pass both back to `holds`/`remove`
 * — never a key lookup, which is what let a late callback reach a replacement.
 *
 * A partition is dropped when its last entry leaves, so a signed-out account's
 * database is not retained by this map.
 */
export interface AcquiredEntry<E> {
  /** The account database the entry reads from. Query and tear down against it. */
  database: ThreaDatabase
  entry: E
  /** True when `create` just built it — the caller opens the subscription. */
  isNew: boolean
}

export interface DbScopedRegistry<E> {
  /** The active account's entry for `key`, creating it if this is the first holder. */
  acquire(key: string, create: () => E): AcquiredEntry<E>
  /** Whether `entry` is still the registered entry for (database, key). */
  holds(database: ThreaDatabase, key: string, entry: E): boolean
  /** Drop `entry`, only if it is still the registered one. */
  remove(database: ThreaDatabase, key: string, entry: E): void
  /** The active account's entry for `key`, without creating one. */
  peek(key: string): E | undefined
  /** The active account's entries, for a reader that must scan its own account. */
  activeEntries(): [string, E][]
  /** Every entry across every account, for teardown and leak counts. */
  all(): E[]
  size(): number
  clear(): void
}

export function createDbScopedRegistry<E>(): DbScopedRegistry<E> {
  const partitions = new Map<ThreaDatabase, Map<string, E>>()

  const partitionFor = (database: ThreaDatabase): Map<string, E> => {
    let partition = partitions.get(database)
    if (!partition) {
      partition = new Map<string, E>()
      partitions.set(database, partition)
    }
    return partition
  }

  return {
    acquire(key, create) {
      const database = getActiveDb()
      const partition = partitionFor(database)
      const existing = partition.get(key)
      if (existing) return { database, entry: existing, isNew: false }
      // Registered before the caller subscribes, so a snapshot read taken
      // between `acquire` and the subscription still finds the entry.
      const entry = create()
      partition.set(key, entry)
      return { database, entry, isNew: true }
    },
    holds(database, key, entry) {
      return partitions.get(database)?.get(key) === entry
    },
    remove(database, key, entry) {
      const partition = partitions.get(database)
      if (!partition || partition.get(key) !== entry) return
      partition.delete(key)
      if (partition.size === 0) partitions.delete(database)
    },
    peek(key) {
      return partitions.get(getActiveDb())?.get(key)
    },
    activeEntries() {
      const partition = partitions.get(getActiveDb())
      return partition ? [...partition] : []
    },
    all() {
      const entries: E[] = []
      for (const partition of partitions.values()) entries.push(...partition.values())
      return entries
    },
    size() {
      let count = 0
      for (const partition of partitions.values()) count += partition.size
      return count
    },
    clear() {
      partitions.clear()
    },
  }
}
