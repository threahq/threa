import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { parseConfigFile, type RawConfig } from "./identity"

/**
 * A connector's optional JSON config file. Absent is undefined; a damaged file
 * is logged and ignored so env vars can still carry the config.
 */
export function readConfigFile(path: string, log: (message: string) => void): RawConfig | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parseConfigFile(readFileSync(path, "utf8"))
  } catch (error) {
    log(`ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Owner-only from the first byte, then swapped in whole: an existing file's
 * looser mode never applies to the new content, and a reader or a crash never
 * sees a half-written file.
 */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode, flag: "wx" })
  chmodSync(temp, mode)
  renameSync(temp, path)
}
