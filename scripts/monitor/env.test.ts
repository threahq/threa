import { describe, expect, test } from "bun:test"
import { parseEnvFile, resolveCredentials } from "./env"

describe("parseEnvFile", () => {
  test("reads plain, quoted and exported assignments, ignores comments", () => {
    const text = `# creds\nexport RAILWAY_READONLY_TOKEN="tok en"\nDB_READ_PROXY_URL='https://x'\nTHREA_PROD_BASE_URL=https://app.threa.io\nbroken line\n`
    expect(parseEnvFile(text)).toEqual({
      RAILWAY_READONLY_TOKEN: "tok en",
      DB_READ_PROXY_URL: "https://x",
      THREA_PROD_BASE_URL: "https://app.threa.io",
    })
  })
})

describe("resolveCredentials", () => {
  test("process env wins, file fills gaps, the rest is reported missing", () => {
    const loaded = resolveCredentials(
      { RAILWAY_READONLY_TOKEN: "from-env" },
      "RAILWAY_READONLY_TOKEN=from-file\nDB_READ_PROXY_URL=https://proxy\nDB_READ_PROXY_SECRET=s\n"
    )
    expect(loaded.creds).toEqual({
      RAILWAY_READONLY_TOKEN: "from-env",
      DB_READ_PROXY_URL: "https://proxy",
      DB_READ_PROXY_SECRET: "s",
    })
    expect(loaded.fromFile).toEqual(["DB_READ_PROXY_URL", "DB_READ_PROXY_SECRET"])
    expect(loaded.missing).toEqual([
      "THREA_PROD_BASE_URL",
      "THREA_PROD_READ_ONLY_API_KEY",
      "THREA_PROD_DEFAULT_WORKSPACE",
    ])
  })
})
