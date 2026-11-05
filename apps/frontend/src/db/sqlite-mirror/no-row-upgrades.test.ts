import { describe, expect, it } from "vitest"
import { ThreaDatabase } from "../database"

interface DexieVersion {
  _cfg: { version: number; contentUpgrade: unknown }
}

describe("IndexedDB schema versions", () => {
  it("upgrades rows only in versions before SQLite took the mirrored stores, whose IndexedDB copies an import leaves empty", () => {
    const database = new ThreaDatabase(`no_row_upgrades_${Date.now()}`)
    const versions = (database as unknown as { _versions: DexieVersion[] })._versions
    const upgrading = versions.filter((version) => version._cfg.contentUpgrade).map((version) => version._cfg.version)
    expect(upgrading.filter((version) => version > 56)).toEqual([])
    database.close()
  })
})
