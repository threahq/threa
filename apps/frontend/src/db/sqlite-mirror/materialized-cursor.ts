import type { DBCoreCursor, DBCoreTransaction } from "dexie"
import { compareBytes, decodeKey, encodeKey } from "./key-codec"
import type { MirrorQueryStart, MirrorRow } from "./mirror-store"
import { decodeValue } from "./value-codec"

export const CURSOR_PAGE_ROWS = 500

interface CursorOptions {
  trans: DBCoreTransaction
  reverse: boolean
  /** Rows sharing a key are distinguished by primary key, so paging resumes on both. */
  byPrimaryKey: boolean
  firstPage: MirrorRow[]
  fetchPage: (from: MirrorQueryStart) => Promise<MirrorRow[]>
}

type Moved = boolean | Promise<boolean>

/**
 * A DBCore cursor over pages of query results. Moves within a page run
 * synchronously in one loop, so a long iteration neither recurses nor waits
 * on a macrotask per row; seeks past the page fetch from the target.
 */
export function materializedCursor(options: CursorOptions): DBCoreCursor | null {
  const { trans, reverse, byPrimaryKey, fetchPage } = options
  let rows = options.firstPage
  if (rows.length === 0) return null
  let index = 0
  let exhausted = rows.length < CURSOR_PAGE_ROWS
  let done = false
  let decoded: { row: MirrorRow; key?: IDBValidKey; primaryKey?: IDBValidKey; value?: unknown } = { row: rows[0] }
  let onNext: (() => void) | null = null
  let pendingMove: (() => Moved) | null = null
  let running = false
  let settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null

  const current = () => {
    if (decoded.row !== rows[index]) decoded = { row: rows[index] }
    return decoded
  }

  const load = async (from: MirrorQueryStart): Promise<boolean> => {
    rows = await fetchPage(from)
    index = 0
    exhausted = rows.length < CURSOR_PAGE_ROWS
    return rows.length > 0
  }

  const step = (): Moved => {
    index++
    if (index < rows.length) return true
    if (exhausted) return false
    const last = rows[rows.length - 1]
    return load({ key: last.key, primaryKey: byPrimaryKey ? last.primaryKey : null, open: true })
  }

  const passes = (row: MirrorRow, key: Uint8Array, primaryKey: Uint8Array | null): boolean => {
    const sign = reverse ? -1 : 1
    const byKey = compareBytes(row.key, key) * sign
    if (byKey !== 0 || primaryKey === null) return byKey >= 0
    return compareBytes(row.primaryKey, primaryKey) * sign >= 0
  }

  const seek = (key: Uint8Array, primaryKey: Uint8Array | null): Moved => {
    for (let i = index + 1; i < rows.length; i++) {
      if (passes(rows[i], key, primaryKey)) {
        index = i
        return true
      }
    }
    if (exhausted) return false
    return load({ key, primaryKey, open: false })
  }

  const advance = async (count: number): Promise<boolean> => {
    for (let i = 0; i < count; i++) {
      if (!(await step())) return false
    }
    return true
  }

  const stop = (value?: unknown) => {
    const pending = settle
    settle = null
    onNext = null
    pending?.resolve(value)
  }

  const fail = (error: unknown) => {
    const pending = settle
    settle = null
    onNext = null
    pending?.reject(error)
  }

  const run = async () => {
    running = true
    try {
      while (pendingMove && onNext) {
        const move = pendingMove
        pendingMove = null
        const moved = move()
        if (!(typeof moved === "boolean" ? moved : await moved)) {
          done = true
          stop()
          return
        }
        onNext?.()
      }
    } catch (error) {
      fail(error)
    } finally {
      running = false
    }
  }

  const move = (next: () => Moved) => {
    if (!onNext) throw new Error("Cursor not started")
    pendingMove = next
    if (!running) void run()
  }

  const cursor: DBCoreCursor = {
    trans,
    get key() {
      const state = current()
      return (state.key ??= decodeKey(state.row.key))
    },
    get primaryKey() {
      const state = current()
      return (state.primaryKey ??= decodeKey(state.row.primaryKey))
    },
    get value() {
      const state = current()
      if (state.row.value === undefined) return undefined
      if (!("value" in state)) state.value = decodeValue(state.row.value)
      return state.value
    },
    get done() {
      return done
    },
    continue(key?: IDBValidKey) {
      move(key === undefined ? step : () => seek(encodeKey(key), null))
    },
    continuePrimaryKey(key: IDBValidKey, primaryKey: IDBValidKey) {
      move(() => seek(encodeKey(key), encodeKey(primaryKey)))
    },
    advance(count: number) {
      move(() => advance(count))
    },
    stop,
    fail,
    start(callback) {
      if (done) throw new Error("Cursor behind last entry")
      const iteration = new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
      onNext = () => {
        try {
          callback()
        } catch (error) {
          fail(error)
        }
      }
      onNext()
      return iteration
    },
    next() {
      let gotOne = 1
      return cursor.start(() => (gotOne-- ? cursor.continue() : cursor.stop())).then(() => cursor)
    },
  }
  return cursor
}
