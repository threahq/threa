import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isSafeSessionFileName } from "@threa/bot-runtime-client"
import { canonicalOrRaw } from "./discovery"

/**
 * Where a runtime session's identity is RECORDED, so nothing has to recompute
 * it. `deriveClaudeRuntimeIdentity` hashes `os.hostname()`, which is
 * DHCP-supplied on this laptop: the derived id changes with the wifi network
 * and a session becomes unrecognisable to its own harness.
 *
 * One file per session, never a shared document: several processes write
 * concurrently and a read-modify-write on one file would lose entries.
 */
export interface MintedIdentity {
  runtimeSessionId: string
  instanceId: string
  worktree: string
  runtimeKind: string
  mintedAt: string
  source: "mint" | "backfill"
  attestedBy?: "ledger" | "inventory" | "launch"
}

export type WriteMintedIdentityResult =
  | { status: "created"; record: MintedIdentity }
  | { status: "exists"; existing: MintedIdentity }
  | { status: "refused"; reason: string }

export function identityStoreDir(): string {
  return process.env.THREA_HARNESSD_IDENTITIES_DIR || join(homedir(), ".threa", "harnessd", "identities")
}

function identityPath(runtimeSessionId: string): string | undefined {
  if (!isSafeSessionFileName(runtimeSessionId)) return undefined
  return join(identityStoreDir(), `${runtimeSessionId}.json`)
}

function parseRecord(text: string): MintedIdentity | undefined {
  const parsed = JSON.parse(text) as Partial<MintedIdentity>
  if (
    typeof parsed.runtimeSessionId !== "string" ||
    !parsed.runtimeSessionId ||
    typeof parsed.instanceId !== "string" ||
    !parsed.instanceId ||
    typeof parsed.worktree !== "string" ||
    !parsed.worktree ||
    (parsed.source !== "mint" && parsed.source !== "backfill")
  ) {
    return undefined
  }
  return {
    runtimeSessionId: parsed.runtimeSessionId,
    instanceId: parsed.instanceId,
    worktree: parsed.worktree,
    runtimeKind: typeof parsed.runtimeKind === "string" ? parsed.runtimeKind : "unknown",
    mintedAt: typeof parsed.mintedAt === "string" ? parsed.mintedAt : "",
    source: parsed.source,
    ...(parsed.attestedBy === "ledger" || parsed.attestedBy === "inventory" || parsed.attestedBy === "launch"
      ? { attestedBy: parsed.attestedBy }
      : {}),
  }
}

/** Every recorded identity. Unreadable or malformed files are skipped, not fatal. */
export function readMintedIdentities(): MintedIdentity[] {
  const dir = identityStoreDir()
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json"))
  } catch {
    return []
  }
  const records: MintedIdentity[] = []
  for (const entry of entries) {
    try {
      const record = parseRecord(readFileSync(join(dir, entry), "utf8"))
      if (record) records.push(record)
    } catch {
      // Skip: a half-written or hand-edited file must not abort the sweep.
    }
  }
  return records
}

export function readMintedIdentity(runtimeSessionId: string): MintedIdentity | undefined {
  const path = identityPath(runtimeSessionId)
  if (!path) return undefined
  try {
    return parseRecord(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Both sides are canonicalized, and the canonicalizer is a parameter: the mint
 * injects its own, and a record written by another writer may name the path it
 * was given rather than the resolved one.
 */
export function identityRecordsFor(
  worktree: string,
  records: MintedIdentity[] = readMintedIdentities(),
  canonical: (path: string) => string = canonicalOrRaw
): MintedIdentity[] {
  const target = canonical(worktree)
  return records.filter((record) => canonical(record.worktree) === target)
}

/**
 * Retire every identity recorded for a directory that no longer exists.
 *
 * Symmetric with `clearHarnessLink`, which the reaper already calls on the same
 * transition and whose own contract is that records for departed worktrees are
 * pruned here. Without it the binding outlives the directory: the planned path
 * is deterministic from repo and agent name, so the next `spawn` of that name
 * resolves to the same path, finds the dead session's record, and launches under
 * a `runtimeSessionId` the server already knows as wound down.
 */
export function forgetMintedIdentitiesFor(worktree: string): string[] {
  const retired: string[] = []
  for (const record of identityRecordsFor(worktree)) {
    const path = identityPath(record.runtimeSessionId)
    if (!path) continue
    try {
      rmSync(path, { force: true })
      retired.push(record.runtimeSessionId)
    } catch {
      // A leftover record only costs the next spawn a stale reuse, which the
      // caller reports; it must never abort the reap that is already underway.
    }
  }
  return retired
}

/**
 * Create-then-reread. Reporting a create that was never confirmed is exactly
 * the silent failure this store exists to remove, so the record is read back
 * and compared before `created` is returned. `EEXIST` yields the winner's
 * record from disk, so a lost race adopts the id that actually landed.
 *
 * An unsafe id is refused, never sanitised: rewriting it would silently map
 * two distinct session ids onto one file.
 */
export function writeMintedIdentity(record: MintedIdentity): WriteMintedIdentityResult {
  const path = identityPath(record.runtimeSessionId)
  if (!path)
    return { status: "refused", reason: `unsafe runtime session id: ${JSON.stringify(record.runtimeSessionId)}` }
  const json = `${JSON.stringify(record, null, 2)}\n`
  try {
    mkdirSync(identityStoreDir(), { recursive: true })
    writeFileSync(path, json, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return { status: "refused", reason: `could not write ${path}: ${error}` }
    }
    const existing = readMintedIdentity(record.runtimeSessionId)
    return existing
      ? { status: "exists", existing }
      : { status: "refused", reason: `${path} exists but holds no readable identity record` }
  }
  const landed = readMintedIdentity(record.runtimeSessionId)
  if (!landed || landed.runtimeSessionId !== record.runtimeSessionId || landed.instanceId !== record.instanceId) {
    return { status: "refused", reason: `identity record did not read back as written: ${path}` }
  }
  return { status: "created", record: landed }
}
