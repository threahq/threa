import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discardCommandClaim, readCommandClaim, writeCommandClaim, type CommandClaim } from "./command-claim"

const CLAIM: CommandClaim = {
  runtime: "claude",
  workspaceId: "ws_1",
  invocationId: "binv_1",
  instanceId: "cc-1",
  claimToken: "tok-secret",
}

describe("command claim file", () => {
  it("writes the claim to a private file and reading it removes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-claim-test-"))
    const path = writeCommandClaim(CLAIM, { dir })
    const mode = statSync(path).mode & 0o777
    const written = JSON.parse(readFileSync(path, "utf8"))

    const read = readCommandClaim(path)

    expect({ mode, written, read, left: existsSync(path) }).toEqual({
      mode: 0o600,
      written: CLAIM,
      read: CLAIM,
      left: false,
    })
  })

  it("rejects a claim missing a field or naming an unknown runtime, and still removes the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "command-claim-test-"))
    const missing = join(dir, "missing.json")
    writeFileSync(missing, JSON.stringify({ ...CLAIM, claimToken: " " }))
    const unknown = join(dir, "unknown.json")
    writeFileSync(unknown, JSON.stringify({ ...CLAIM, runtime: "codex" }))

    expect(() => readCommandClaim(missing)).toThrow("missing claimToken")
    expect(() => readCommandClaim(unknown)).toThrow("unknown runtime")
    expect(() => readCommandClaim(join(dir, "absent.json"))).toThrow()
    expect({ missing: existsSync(missing), unknown: existsSync(unknown) }).toEqual({ missing: false, unknown: false })
  })

  it("discards an absent file without throwing", () => {
    expect(() => discardCommandClaim(join(tmpdir(), "command-claim-never-written.json"))).not.toThrow()
    expect(() => discardCommandClaim(undefined)).not.toThrow()
  })
})
