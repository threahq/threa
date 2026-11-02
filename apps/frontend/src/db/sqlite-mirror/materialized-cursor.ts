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
  /** The next page from SQLite, or, once SQLite cannot serve it, a native cursor over the same query to read the rest from. */
  fetchPage: (from: MirrorQueryStart) => Promise<MirrorRow[] | DBCoreCursor | null>
}

type Moved = boolean | Promise<boolean>

/**
 * A DBCore cursor over pages of query results. Moves within a page run
 * synchronously in one loop, so a long iteration neither recurses nor waits
 * on a macrotask per row; seeks past the page fetch from the target. Once a
 * page falls back to IndexedDB, the native cursor is moved past every row
 * already yielded and serves the rest of the iteration.
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
  let native: DBCoreCursor | null = null
  let nativeIterating = false
  let nativeMove: { resolve: (moved: boolean) => void; reject: (error: unknown) => void } | null = null

  const takeNativeMove = () => {
    const pending = nativeMove
    nativeMove = null
    return pending
  }

  const moveNative = (op: (cursor: DBCoreCursor) => void): Promise<boolean> =>
    new Promise((resolve, reject) => {
      nativeMove = { resolve, reject }
      op(native as DBCoreCursor)
    })

  const toNative = (cursor: DBCoreCursor | null, from: MirrorQueryStart): Promise<boolean> => {
    if (!cursor) return Promise.resolve(false)
    native = cursor
    nativeIterating = true
    let positioned = false
    return moveNative(() => {
      cursor
        .start(() => {
          if (!positioned) {
            const skip = skipTo(cursor, { reverse, byPrimaryKey }, from)
            if (skip) return skip()
            positioned = true
          }
          takeNativeMove()?.resolve(true)
        })
        .finally(() => (nativeIterating = false))
        .then(
          () => takeNativeMove()?.resolve(false),
          (error: unknown) => takeNativeMove()?.reject(error)
        )
    })
  }

  const current = () => {
    if (decoded.row !== rows[index]) decoded = { row: rows[index] }
    return decoded
  }

  const load = async (from: MirrorQueryStart): Promise<boolean> => {
    const page = await fetchPage(from)
    if (!Array.isArray(page)) return toNative(page, from)
    rows = page
    index = 0
    exhausted = rows.length < CURSOR_PAGE_ROWS
    return rows.length > 0
  }

  const step = (): Moved => {
    if (native) return moveNative((cursor) => cursor.continue())
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
    if (native) {
      return moveNative((cursor) =>
        primaryKey === null
          ? cursor.continue(decodeKey(key))
          : cursor.continuePrimaryKey(decodeKey(key), decodeKey(primaryKey))
      )
    }
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
    if (native) return moveNative((cursor) => cursor.advance(count))
    for (let i = 0; i < count; i++) {
      if (!(await step())) return false
    }
    return true
  }

  const stopNative = () => {
    if (!nativeIterating) return
    nativeIterating = false
    native?.stop()
  }

  const stop = (value?: unknown) => {
    stopNative()
    const pending = settle
    settle = null
    onNext = null
    pending?.resolve(value)
  }

  const fail = (error: unknown) => {
    stopNative()
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
      if (native) return native.key
      const state = current()
      return (state.key ??= decodeKey(state.row.key))
    },
    get primaryKey() {
      if (native) return native.primaryKey
      const state = current()
      return (state.primaryKey ??= decodeKey(state.row.primaryKey))
    },
    get value() {
      if (native) return native.value
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

/** The move that takes a native cursor toward the first row past `from`, or null once it is there. */
function skipTo(
  cursor: DBCoreCursor,
  options: { reverse: boolean; byPrimaryKey: boolean },
  from: MirrorQueryStart
): (() => void) | null {
  const sign = options.reverse ? -1 : 1
  const byKey = compareBytes(encodeKey(cursor.key), from.key) * sign
  if (byKey < 0) return () => cursor.continue(decodeKey(from.key))
  if (byKey > 0) return null
  const primaryKey = from.primaryKey
  if (options.byPrimaryKey && primaryKey !== null) {
    const byPrimaryKey = compareBytes(encodeKey(cursor.primaryKey), primaryKey) * sign
    if (byPrimaryKey < 0) return () => cursor.continuePrimaryKey(decodeKey(from.key), decodeKey(primaryKey))
    if (byPrimaryKey > 0) return null
  }
  return from.open ? () => cursor.continue() : null
}
