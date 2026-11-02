/** Stores whose rows hold values SQLite cannot represent: a non-extractable CryptoKey, and Blobs. */
export const SQLITE_UNMIRRORED_STORES: ReadonlySet<string> = new Set(["e2eDeviceKeys", "uploadJobs"])
