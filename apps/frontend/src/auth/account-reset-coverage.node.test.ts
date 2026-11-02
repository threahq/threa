import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * A module-scoped store outlives the account-keyed remount, so what it holds is
 * still there under the next account unless `flushModuleStoreCaches` drops it —
 * a list that used to be hand-maintained, with nothing to say a new store had
 * been forgotten. This reads the stores themselves and holds the list to them.
 */

const STORES_DIR = join(import.meta.dirname, "..", "stores")

/** Stores whose state is the device's, not an account's. */
const DEVICE_SCOPED: Record<string, string> = {
  "call-prefs-store.ts": "camera/mic layout choices belong to this device, and are not derived from any account's data",
}

/** Exported no-argument resets: the shape of a store-wide wipe. */
function storeWideResets(source: string): string[] {
  return [...source.matchAll(/export function (\w*[Rr]eset\w*)\(\s*\)/g)].map((match) => match[1])
}

describe("account switch store coverage", () => {
  const scopeSource = readFileSync(join(import.meta.dirname, "account-scope.tsx"), "utf8")

  it("should drop every module-scoped store the switch does not otherwise own", () => {
    const missed: string[] = []

    for (const file of readdirSync(STORES_DIR)) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue
      if (file in DEVICE_SCOPED) continue
      for (const reset of storeWideResets(readFileSync(join(STORES_DIR, file), "utf8"))) {
        if (reset.includes("ForTest")) continue
        if (!scopeSource.includes(`${reset}(`)) missed.push(`${file}: ${reset}`)
      }
    }

    expect(missed).toEqual([])
  })

  it("should keep the device-scoped exemptions honest", () => {
    const files = new Set(readdirSync(STORES_DIR))
    expect([...Object.keys(DEVICE_SCOPED)].filter((file) => !files.has(file))).toEqual([])
  })
})
