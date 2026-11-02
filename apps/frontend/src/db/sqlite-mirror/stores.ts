import { SQLITE_MARKS_STORE } from "./marks"

/** Stores never copied to SQLite: values it cannot represent (a non-extractable CryptoKey, Blobs), and the mirror's own marks. */
export const SQLITE_UNMIRRORED_STORES: ReadonlySet<string> = new Set([
  "e2eDeviceKeys",
  "uploadJobs",
  SQLITE_MARKS_STORE,
])
