import { randomUUID } from "node:crypto"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface ClaimFields {
  workspaceId: string
  invocationId: string
  instanceId: string
  claimToken: string
}

/**
 * A still-open slash command handed to harnessd to drive to its end: the
 * invocation stays claimed, harnessd renews it, reports its steps into it and
 * closes it. `runtime` names whose credentials the claim was made under; a
 * T3 Code connector's live nowhere harnessd reads, so its claim carries them.
 */
export type CommandClaim = ClaimFields &
  ({ runtime: "claude" | "pi" } | { runtime: "t3code"; baseUrl: string; apiKey: string })

/** harnessd reads the claim once and unlinks it; only a launch that never reached harnessd needs {@link discardCommandClaim}. */
export function writeCommandClaim(claim: CommandClaim, options: { dir?: string } = {}): string {
  const path = join(options.dir ?? tmpdir(), `threa-claim-${randomUUID()}.json`)
  writeFileSync(path, JSON.stringify(claim), { flag: "wx", mode: 0o600 })
  return path
}

/** Reads and removes the claim file in one step: the token inside is a live credential that must not outlive its reader. */
export function readCommandClaim(path: string): CommandClaim {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } finally {
    discardCommandClaim(path)
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") throw new Error(`claim file ${path} is not an object`)
  const record = parsed as Record<string, unknown>
  const field = (name: string): string => {
    const value = record[name]
    if (typeof value !== "string" || !value.trim()) throw new Error(`claim file ${path} is missing ${name}`)
    return value
  }
  const fields: ClaimFields = {
    workspaceId: field("workspaceId"),
    invocationId: field("invocationId"),
    instanceId: field("instanceId"),
    claimToken: field("claimToken"),
  }
  const runtime = record.runtime
  if (runtime === "claude" || runtime === "pi") return { runtime, ...fields }
  if (runtime === "t3code") return { runtime, baseUrl: field("baseUrl"), apiKey: field("apiKey"), ...fields }
  throw new Error(`claim file ${path} names an unknown runtime`)
}

export function discardCommandClaim(path: string | undefined): void {
  if (!path) return
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or never written; the caller is on a failure path already.
  }
}
