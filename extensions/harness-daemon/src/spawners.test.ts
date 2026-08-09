import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mcpConfigDir, mcpConfigPath, writeChannelMcpConfig } from "./spawners"
import { profileForWorktree, recordProfileSnapshot } from "./identity-store"
import { windDownPolicyFor, type Profile } from "./profiles"

let root: string
let savedDir: string | undefined
let savedIdentities: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnessd-mcp-"))
  savedDir = process.env.THREA_HARNESSD_MCP_DIR
  process.env.THREA_HARNESSD_MCP_DIR = join(root, "mcp")
  savedIdentities = process.env.THREA_HARNESSD_IDENTITIES_DIR
  process.env.THREA_HARNESSD_IDENTITIES_DIR = join(root, "identities")
})

afterEach(() => {
  if (savedDir === undefined) delete process.env.THREA_HARNESSD_MCP_DIR
  else process.env.THREA_HARNESSD_MCP_DIR = savedDir
  if (savedIdentities === undefined) delete process.env.THREA_HARNESSD_IDENTITIES_DIR
  else process.env.THREA_HARNESSD_IDENTITIES_DIR = savedIdentities
  rmSync(root, { recursive: true, force: true })
})

/** A test that silently wrote the developer's real ~/.threa/harnessd would be worse than red. */
function guardDir(): void {
  if (!mcpConfigDir().startsWith(root)) throw new Error(`MCP dir override did not take: ${mcpConfigDir()}`)
}

test("the MCP config path is keyed by runtime session id, not the agent name", () => {
  guardDir()
  expect(mcpConfigPath("ccs-abc123")).toBe(join(root, "mcp", "ccs-abc123.json"))
})

test("two agents sharing a name get separate MCP configs", () => {
  // One file per name meant the second spawn of a name silently repointed the
  // first session's channel at its own entry.
  guardDir()
  const first = writeChannelMcpConfig("ccs-one", "threa-channel", "/entry/one.ts")
  const second = writeChannelMcpConfig("ccs-two", "threa-channel", "/entry/two.ts")

  expect(first).not.toBe(second)
  expect(JSON.parse(readFileSync(first, "utf8"))).toMatchObject({
    mcpServers: { "threa-channel": { args: ["/entry/one.ts"] } },
  })
  expect(JSON.parse(readFileSync(second, "utf8"))).toMatchObject({
    mcpServers: { "threa-channel": { args: ["/entry/two.ts"] } },
  })
})

test("a resume writes the new key and leaves the old name-keyed file in place", () => {
  // `reconnect` validates that the path in a live pane's recorded launch command
  // still exists, so deleting the old file would break a running session.
  guardDir()
  const legacy = mcpConfigPath("fix-sidebar")
  mkdirSync(mcpConfigDir(), { recursive: true })
  writeFileSync(legacy, JSON.stringify({ mcpServers: { "threa-channel": { args: ["/old/entry.ts"] } } }))

  const written = writeChannelMcpConfig("ccs-sidebar", "threa-channel", "/new/entry.ts")

  expect(written).toBe(mcpConfigPath("ccs-sidebar"))
  expect(existsSync(legacy)).toBe(true)
  expect(JSON.parse(readFileSync(legacy, "utf8"))).toMatchObject({
    mcpServers: { "threa-channel": { args: ["/old/entry.ts"] } },
  })
})

test("a Pi spawn records the profile its directory was provisioned under", () => {
  // Pi does not mint, but `pi-local` links ARE reaped and the reaper reads the
  // profile by worktree. With no snapshot it falls back to the built-in default,
  // which commits, pushes and reclaims a directory the operator owns.
  const profile: Profile = {
    name: "orchestrator",
    provision: "existing",
    preserve: "none",
    setup: [],
    teardown: ["echo bye"],
  }
  recordProfileSnapshot({
    worktree: "/repo/orchestrator",
    runtimeSessionId: "pi-abc",
    runtimeKind: "pi-local",
    profile,
  })

  expect(profileForWorktree("/repo/orchestrator", "pi-local")).toEqual(profile)
  expect(windDownPolicyFor(profileForWorktree("/repo/orchestrator", "pi-local"))).toEqual({
    preserve: "none",
    reclaim: false,
  })
})
