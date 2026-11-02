import { transactionDone, type Touched } from "./idb-reads"

/**
 * IndexedDB's record of who wrote each mirrored store. Every readwrite
 * transaction over a mirrored store, from any context (tab, service worker,
 * mirror running or not), puts a mark in the same transaction as its writes,
 * so no write can commit without one.
 */
export const SQLITE_MARKS_STORE = "sqliteMarks"

/**
 * The latest transaction of `writer` that wrote `store`. SQLite holds every
 * such write once its record of the writer's writes to the store reaches
 * `seq`; a mark past it names a store SQLite may lack writes to.
 */
export interface SqliteMark {
  store: string
  writer: string
  seq: number
}

/** Names this IndexedDB's lifetime; a deleted and recreated database gets a new one, so its SQLite copy is not trusted. */
interface IncarnationRow {
  store: ""
  writer: "incarnation"
  id: string
}

/**
 * A writer's transaction that committed marks and, per store it marked, the
 * writer's previous transaction that marked that store (0 for none), so SQLite
 * can tell when it holds every one of them.
 */
export interface WriterCommit {
  writer: string
  seq: number
  prev: Record<string, number>
}

/** Per writer and store, the seq through which SQLite holds every commit of the writer to the store. */
export type HeldCommits = Record<string, Record<string, number>>

export function holds(held: HeldCommits, mark: SqliteMark): boolean {
  return mark.seq <= (held[mark.writer]?.[mark.store] ?? 0)
}

/**
 * Each writer's committed writes as the touched keys, for the owner to copy
 * from IndexedDB; the owner's acknowledgement once SQLite holds them; and a
 * new owner's announcement, on which mirroring tabs re-send every batch still
 * unacknowledged.
 */
export type MirrorBroadcast =
  | { type: "batch"; from: string; id: number; prev: Record<string, number>; touched: Touched[] }
  | { type: "ack"; to: string; id: number }
  | { type: "owner" }

export type MirrorBatch = Extract<MirrorBroadcast, { type: "batch" }>

export function mirrorChannelName(idbName: string): string {
  return `threa-sqlite-mirror:${idbName}`
}

export function writerBatch(commit: WriterCommit, touched: Touched[]): MirrorBatch {
  return { type: "batch", from: commit.writer, id: commit.seq, prev: commit.prev, touched }
}

/** One database handle as a writer of mirrored stores. */
export class IdbWriter {
  readonly id = crypto.randomUUID()
  private lastSeq = 0
  private readonly lastCommitted = new Map<string, number>()

  constructor(readonly idbName: string) {}

  /** At transaction creation: transactions sharing the marks store commit in creation order. */
  nextSeq(): number {
    return ++this.lastSeq
  }

  /** In commit order, for each transaction that put marks. */
  committed(seq: number, stores: Iterable<string>): WriterCommit {
    const prev: Record<string, number> = {}
    for (const store of stores) {
      prev[store] = this.lastCommitted.get(store) ?? 0
      this.lastCommitted.set(store, seq)
    }
    return { writer: this.id, seq, prev }
  }

  /** A handle without a running mirror tells a live owner what it wrote; its marks cover an owner that is not listening. */
  announce(batch: MirrorBatch): void {
    if (typeof BroadcastChannel === "undefined") return
    const channel = new BroadcastChannel(mirrorChannelName(this.idbName))
    channel.postMessage(batch)
    channel.close()
  }
}

/** Every mark, and this database's incarnation, created on first read. */
export async function readMarks(idb: IDBDatabase): Promise<{ incarnation: string; marks: SqliteMark[] }> {
  const tx = idb.transaction(SQLITE_MARKS_STORE, "readwrite")
  const store = tx.objectStore(SQLITE_MARKS_STORE)
  const rows = store.getAll()
  let incarnation = ""
  rows.onsuccess = () => {
    const found = (rows.result as Array<SqliteMark | IncarnationRow>).find((row) => row.store === "")
    if (found) {
      incarnation = (found as IncarnationRow).id
      return
    }
    incarnation = crypto.randomUUID()
    store.put({ store: "", writer: "incarnation", id: incarnation } satisfies IncarnationRow)
  }
  await transactionDone(tx)
  const marks = (rows.result as Array<SqliteMark | IncarnationRow>).filter((row): row is SqliteMark => row.store !== "")
  return { incarnation, marks }
}

/** Deletes each mark still at the seq it was read at; one a writer has advanced since stays. */
export async function deleteMarks(idb: IDBDatabase, marks: readonly SqliteMark[]): Promise<void> {
  if (marks.length === 0) return
  const tx = idb.transaction(SQLITE_MARKS_STORE, "readwrite")
  const store = tx.objectStore(SQLITE_MARKS_STORE)
  for (const mark of marks) {
    const key = [mark.store, mark.writer]
    const current = store.get(key)
    current.onsuccess = () => {
      if ((current.result as SqliteMark | undefined)?.seq === mark.seq) store.delete(key)
    }
  }
  await transactionDone(tx)
}
