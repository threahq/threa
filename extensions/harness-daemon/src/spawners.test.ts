import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudeResumeSessionId,
  mcpConfigDir,
  mcpConfigPath,
  parkPiSessionFiles,
  writeChannelMcpConfig,
} from "./spawners"
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

test("parking a Pi session renames only that session's transcripts", () => {
  // The Threa link in threa-remote.json is keyed by the session id, so the id
  // has to survive: renaming the transcript makes `pi --session-id` recreate an
  // empty one under the same id instead of resuming the old conversation.
  const sessionsDir = join(root, "pi-sessions")
  const projectDir = join(sessionsDir, "a-project")
  mkdirSync(projectDir, { recursive: true })
  const target = join(projectDir, "2026-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl")
  const unrelated = join(projectDir, "2026-01-01T00-00-00-000Z_99999999-8888-7777-6666-555555555555.jsonl")
  writeFileSync(target, "{}\n")
  writeFileSync(unrelated, "{}\n")

  const parked = parkPiSessionFiles("11111111-2222-3333-4444-555555555555", { sessionsDir })

  expect(parked).toEqual([target])
  expect(existsSync(target)).toBe(false)
  expect(existsSync(unrelated)).toBe(true)
  expect(readdirSync(projectDir).filter((entry) => entry.includes(".cleared-"))).toHaveLength(1)
})

test("parking a Pi session with no sessions directory is a no-op", () => {
  expect(parkPiSessionFiles("11111111-2222-3333-4444-555555555555", { sessionsDir: join(root, "absent") })).toEqual([])
})

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: operation failed`), { code })
}

test("a stray file in the sessions dir is skipped, not treated as a project", () => {
  const sessionsDir = join(root, "pi-stray")
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(join(sessionsDir, "notes.txt"), "hi\n")

  expect(parkPiSessionFiles("11111111-2222-3333-4444-555555555555", { sessionsDir })).toEqual([])
})

test("a park that cannot read or rename fails loudly instead of acking a fresh start", () => {
  // `pi --session-id <id>` resumes whatever transcript is still on disk, so a
  // swallowed failure hands the user back the conversation they just cleared.
  const sessionsDir = join(root, "pi-unreadable")
  const projectDir = join(sessionsDir, "a-project")
  mkdirSync(projectDir, { recursive: true })
  const target = join(projectDir, "2026-01-01T00-00-00-000Z_11111111-2222-3333-4444-555555555555.jsonl")
  writeFileSync(target, "{}\n")

  expect(() =>
    parkPiSessionFiles("11111111-2222-3333-4444-555555555555", {
      sessionsDir,
      readdir: (path) => {
        if (path === sessionsDir) return readdirSync(path)
        throw errnoError("EACCES")
      },
    })
  ).toThrow(projectDir)

  expect(() =>
    parkPiSessionFiles("11111111-2222-3333-4444-555555555555", {
      sessionsDir,
      readdir: () => {
        throw errnoError("EIO")
      },
    })
  ).toThrow(sessionsDir)

  expect(() =>
    parkPiSessionFiles("11111111-2222-3333-4444-555555555555", {
      sessionsDir,
      rename: () => {
        throw errnoError("EPERM")
      },
    })
  ).toThrow(target)

  expect(existsSync(target)).toBe(true)
})

test("a cleared Claude resume passes no --resume id even when a transcript is resumable", () => {
  // Without this the clear relaunches straight back into the conversation the
  // user asked to leave behind.
  expect(claudeResumeSessionId(true, { sessionId: "e2b1f0c4-0000-4000-8000-000000000000" })).toBeUndefined()
  expect(claudeResumeSessionId(undefined, { sessionId: "e2b1f0c4-0000-4000-8000-000000000000" })).toBe(
    "e2b1f0c4-0000-4000-8000-000000000000"
  )
  expect(claudeResumeSessionId(false, undefined)).toBeUndefined()
})
