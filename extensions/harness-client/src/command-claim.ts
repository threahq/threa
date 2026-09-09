import { randomUUID } from "node:crypto"
import { readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A still-open slash command handed to harnessd to drive to its end: the
 * invocation stays claimed, harnessd renews it, reports its steps into it and
 * closes it. `runtime` names whose credentials the claim was made under.
 */
export interface CommandClaim {
  runtime: "claude" | "pi"
  workspaceId: string
  invocationId: string
  instanceId: string
  claimToken: string
}

const CLAIM_FIELDS = ["runtime", "workspaceId", "invocationId", "instanceId", "claimToken"] as const

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
  for (const field of CLAIM_FIELDS) {
    const value = record[field]
    if (typeof value !== "string" || !value.trim()) throw new Error(`claim file ${path} is missing ${field}`)
  }
  if (record.runtime !== "claude" && record.runtime !== "pi") {
    throw new Error(`claim file ${path} names an unknown runtime`)
  }
  return {
    runtime: record.runtime,
    workspaceId: record.workspaceId as string,
    invocationId: record.invocationId as string,
    instanceId: record.instanceId as string,
    claimToken: record.claimToken as string,
  }
}

export function discardCommandClaim(path: string | undefined): void {
  if (!path) return
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or never written; the caller is on a failure path already.
  }
}
