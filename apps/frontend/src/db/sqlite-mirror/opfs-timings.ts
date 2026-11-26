export interface OpfsTimings {
  handleCount: number
  handleMinMs: number
  handleMaxMs: number
  /** From the first acquisition starting to the last settling. */
  handleSpanMs: number
  /**
   * Wall time per call kind. The kinds run one after another, except sync I/O
   * between concurrent acquisitions, so `installMs` minus their sum is at most
   * the time spent outside OPFS (retry backoff included).
   */
  opfsRootMs: number
  opfsDirMs: number
  opfsFileMs: number
  opfsRemoveMs: number
  opfsListMs: number
  /** While at least one handle acquisition was pending; acquisitions run concurrently. */
  opfsHandleMs: number
  /** Synchronous reads, writes, flushes and truncates on acquired handles. */
  opfsSyncIoMs: number
}

type AsyncMethod = (this: unknown, ...args: never[]) => Promise<unknown>
type SyncMethod = (this: unknown, ...args: never[]) => unknown
type Spans = Array<{ startedAt: number; endedAt: number }>

export interface OpfsApis {
  storage: { getDirectory: AsyncMethod }
  directory: {
    getDirectoryHandle: AsyncMethod
    getFileHandle: AsyncMethod
    removeEntry: AsyncMethod
    [Symbol.asyncIterator](this: unknown): AsyncIterator<unknown>
  }
  file: { createSyncAccessHandle: AsyncMethod }
  syncHandle: Record<(typeof SYNC_IO)[number], SyncMethod>
}

const SYNC_IO = ["read", "write", "flush", "truncate", "getSize", "close"] as const

/**
 * Times every OPFS call made while `install` runs. The pool's install offers no
 * hook of its own, so the APIs are wrapped for its duration.
 */
export async function timeOpfsCalls<T>(
  apis: OpfsApis,
  install: () => Promise<T>
): Promise<{ result: T; timings: OpfsTimings }> {
  const spans: Record<"root" | "dir" | "file" | "remove" | "list" | "handle" | "syncIo", Spans> = {
    root: [],
    dir: [],
    file: [],
    remove: [],
    list: [],
    handle: [],
    syncIo: [],
  }
  const restores = [
    patch(apis.storage, "getDirectory", spans.root),
    patch(apis.directory, "getDirectoryHandle", spans.dir),
    patch(apis.directory, "getFileHandle", spans.file),
    patch(apis.directory, "removeEntry", spans.remove),
    patchListing(apis.directory, spans.list),
    patch(apis.file, "createSyncAccessHandle", spans.handle),
    ...SYNC_IO.map((key) => patchSync(apis.syncHandle, key, spans.syncIo)),
  ]
  try {
    const result = await install()
    return {
      result,
      timings: {
        ...summarizeHandles(spans.handle),
        opfsRootMs: total(spans.root),
        opfsDirMs: total(spans.dir),
        opfsFileMs: total(spans.file),
        opfsRemoveMs: total(spans.remove),
        opfsListMs: total(spans.list),
        opfsHandleMs: covered(spans.handle),
        opfsSyncIoMs: total(spans.syncIo),
      },
    }
  } finally {
    for (const restore of restores) restore()
  }
}

function timed<P extends Promise<unknown>>(spans: Spans, call: () => P): P {
  const startedAt = performance.now()
  const settle = () => spans.push({ startedAt, endedAt: performance.now() })
  const promise = call()
  promise.then(settle, settle)
  return promise
}

function patch<K extends string>(owner: { [P in K]: AsyncMethod }, key: K, spans: Spans): () => void {
  const original = owner[key]
  owner[key] = function (this: unknown, ...args: never[]) {
    return timed(spans, () => original.apply(this, args))
  } as (typeof owner)[K]
  return () => {
    owner[key] = original
  }
}

function patchSync<K extends string>(owner: { [P in K]: SyncMethod }, key: K, spans: Spans): () => void {
  const original = owner[key]
  owner[key] = function (this: unknown, ...args: never[]) {
    const startedAt = performance.now()
    try {
      return original.apply(this, args)
    } finally {
      spans.push({ startedAt, endedAt: performance.now() })
    }
  } as (typeof owner)[K]
  return () => {
    owner[key] = original
  }
}

/** Listing a directory is one `next()` per entry; each is timed. */
function patchListing(owner: OpfsApis["directory"], spans: Spans): () => void {
  const original = owner[Symbol.asyncIterator]
  owner[Symbol.asyncIterator] = function (this: unknown) {
    const entries = original.call(this)
    return {
      next: () => timed(spans, () => entries.next()),
      return: entries.return && ((value?: unknown) => entries.return!(value)),
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
  return () => {
    owner[Symbol.asyncIterator] = original
  }
}

const durations = (spans: Spans) => spans.map((span) => span.endedAt - span.startedAt)

function total(spans: Spans): number {
  return Math.round(durations(spans).reduce((sum, ms) => sum + ms, 0))
}

function covered(spans: Spans): number {
  let ms = 0
  let reachedTo = -Infinity
  for (const span of [...spans].sort((a, b) => a.startedAt - b.startedAt)) {
    ms += Math.max(0, span.endedAt - Math.max(span.startedAt, reachedTo))
    reachedTo = Math.max(reachedTo, span.endedAt)
  }
  return Math.round(ms)
}

function summarizeHandles(spans: Spans) {
  // A pool already installed in this worker resolves without acquiring any.
  if (spans.length === 0) return { handleCount: 0, handleMinMs: 0, handleMaxMs: 0, handleSpanMs: 0 }
  const firstStart = Math.min(...spans.map((span) => span.startedAt))
  const lastEnd = Math.max(...spans.map((span) => span.endedAt))
  return {
    handleCount: spans.length,
    handleMinMs: Math.round(Math.min(...durations(spans))),
    handleMaxMs: Math.round(Math.max(...durations(spans))),
    handleSpanMs: Math.round(lastEnd - firstStart),
  }
}
