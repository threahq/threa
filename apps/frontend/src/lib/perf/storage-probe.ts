import type { PerfCaptureLike } from "./capture"

const PROBE_INTERVAL_MS = 500
const MIN_RECORDED_MS = 30
// An IndexedDB probe this slow is a stall worth comparing against the file probe.
const STALL_MS = 200
const PROBE_NAME = "threa-perf-probe"
const PROBE_STORE = "probe"

function openProbeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROBE_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(PROBE_STORE).put(1, 1)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readProbeRow(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(PROBE_STORE, "readonly").objectStore(PROBE_STORE).get(1)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function openProbeFile(): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(PROBE_NAME, { create: true })
  if ((await handle.getFile()).size === 0) {
    const writable = await handle.createWritable()
    await writable.write("probe")
    await writable.close()
  }
  return handle
}

/**
 * Tells an IndexedDB engine stall apart from slow device storage: every 500 ms
 * it reads one row from a separate IndexedDB database and one small OPFS file.
 * When an IndexedDB read stalls, it records how many file reads finished during
 * the stall and the slowest of them. File reads keep finishing = IndexedDB's own
 * engine is stuck; they stall too = the device's storage is.
 */
export function startStorageProbe(capture: PerfCaptureLike): () => void {
  if (typeof indexedDB === "undefined" || typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return () => {}
  }

  let disposed = false
  let db: IDBDatabase | null = null
  let file: FileSystemFileHandle | null = null
  let idbStartedAt: number | null = null
  let fileInFlight = false
  let fileReadsDuringIdb = 0
  let slowestFileReadDuringIdb = 0

  const probeIdb = (database: IDBDatabase) => {
    const startedAt = performance.now()
    idbStartedAt = startedAt
    fileReadsDuringIdb = 0
    slowestFileReadDuringIdb = 0
    void readProbeRow(database)
      .then(() => {
        if (disposed) return
        const elapsed = performance.now() - startedAt
        if (elapsed >= MIN_RECORDED_MS) capture.mark("probe.idbRead", elapsed)
        if (elapsed >= STALL_MS) {
          capture.mark("probe.fileReadsDuringIdbStall", fileReadsDuringIdb)
          capture.mark("probe.slowestFileReadDuringIdbStall", slowestFileReadDuringIdb)
        }
      })
      .catch(() => {})
      .finally(() => {
        idbStartedAt = null
      })
  }

  const probeFile = (handle: FileSystemFileHandle) => {
    const startedAt = performance.now()
    fileInFlight = true
    void handle
      .getFile()
      .then((blob) => blob.text())
      .then(() => {
        if (disposed) return
        const elapsed = performance.now() - startedAt
        if (elapsed >= MIN_RECORDED_MS) capture.mark("probe.fileRead", elapsed)
        if (idbStartedAt !== null && idbStartedAt <= startedAt) {
          fileReadsDuringIdb += 1
          slowestFileReadDuringIdb = Math.max(slowestFileReadDuringIdb, elapsed)
        }
      })
      .catch(() => {})
      .finally(() => {
        fileInFlight = false
      })
  }

  void Promise.all([openProbeDatabase(), openProbeFile()])
    .then(([database, handle]) => {
      if (disposed) {
        database.close()
        return
      }
      db = database
      file = handle
    })
    .catch(() => {})

  const interval = setInterval(() => {
    if (!db || !file || document.hidden) return
    if (idbStartedAt === null) probeIdb(db)
    if (!fileInFlight) probeFile(file)
  }, PROBE_INTERVAL_MS)

  return () => {
    disposed = true
    clearInterval(interval)
    db?.close()
  }
}
