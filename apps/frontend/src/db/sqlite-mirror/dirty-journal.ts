const KEY_PREFIX = "threa:sqliteDirty:"

function prefixFor(idbName: string): string {
  return `${KEY_PREFIX}${idbName}:`
}

/**
 * Records, in localStorage, that this tab committed IndexedDB writes SQLite may
 * not hold yet. The key is written synchronously at commit, so a tab killed
 * before the mirror acknowledged its writes leaves the key behind, and the next
 * owner re-backfills instead of trusting a copy that lost them.
 */
export class DirtyJournal {
  private readonly key: string
  private readonly pending = new Set<number>()
  private nextId = 0
  private lost = false

  constructor(
    private readonly idbName: string,
    readonly tabId: string,
    private readonly storage: Storage = localStorage
  ) {
    this.key = `${prefixFor(idbName)}${tabId}`
  }

  begin(): number {
    const id = this.nextId++
    if (this.pending.size === 0) this.storage.setItem(this.key, "1")
    this.pending.add(id)
    return id
  }

  end(id: number): void {
    if (!this.pending.delete(id)) return
    if (this.pending.size === 0 && !this.lost) this.storage.removeItem(this.key)
  }

  /** SQLite missed a write for good this session; only a re-backfill clears it. */
  markLost(): void {
    this.lost = true
    this.storage.setItem(this.key, "1")
  }

  /** Keys left by other tabs or by a recreated IndexedDB: each may stand for writes SQLite never received. */
  staleKeys(): string[] {
    const prefix = prefixFor(this.idbName)
    const keys: string[] = []
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i)
      if (key?.startsWith(prefix) && key !== this.key) keys.push(key)
    }
    return keys
  }

  clear(keys: readonly string[]): void {
    for (const key of keys) this.storage.removeItem(key)
  }
}

/** The IndexedDB itself was replaced (deleted and recreated), so nothing in its SQLite copy can be trusted. */
export function markSqliteMirrorStale(idbName: string, storage: Storage = localStorage): void {
  storage.setItem(`${prefixFor(idbName)}recreated`, "1")
}
