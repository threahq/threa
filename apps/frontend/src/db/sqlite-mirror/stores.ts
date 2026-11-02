import { SQLITE_INCARNATION_STORE, isSqliteMarksStore } from "./marks"

/** Stores never copied to SQLite: values it cannot represent (a non-extractable CryptoKey, Blobs), and the mirror's own bookkeeping. */
const SQLITE_UNMIRRORED_STORES: ReadonlySet<string> = new Set(["e2eDeviceKeys", "uploadJobs", SQLITE_INCARNATION_STORE])

export function isMirroredStore(name: string): boolean {
  return !SQLITE_UNMIRRORED_STORES.has(name) && !isSqliteMarksStore(name)
}
