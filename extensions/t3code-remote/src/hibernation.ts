import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { writeFileAtomic } from "@threahq/remote-session"
import { readJsonFile, str } from "./config"

export interface HibernationRecord {
  unit: string
  runtimeSessionId: string
  /** Unknown when the scratchpad was already archived at start: the server refuses the link without naming it. */
  rootStreamId?: string
}

export type Systemctl = (args: string[]) => void

export const systemctlUser: Systemctl = (args) => {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" })
  // A unit stopping itself takes systemctl down with it, once the stop job has been queued.
  if (args[0] === "stop" && result.signal === "SIGTERM") return
  if (result.status !== 0) {
    throw new Error(`systemctl --user ${args.join(" ")} exited with ${result.status}: ${result.stderr?.trim() ?? ""}`)
  }
}

/** The account's home, not `$HOME`: per-scratchpad units each override `HOME`, and the waker must see all of them. */
export function hibernationDir(): string {
  return join(userInfo().homedir, ".threa", "t3code-remote", "hibernating")
}

/**
 * Units whose scratchpad is archived. A hibernating unit is disabled and stopped, so neither a boot nor
 * `Restart=always` brings it back; the waker starts it again once the scratchpad is restored or used.
 */
export class Hibernation {
  constructor(
    private readonly dir: string,
    private readonly systemctl: Systemctl
  ) {}

  list(): HibernationRecord[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return names.flatMap((name) => {
      if (!name.endsWith(".json")) return []
      const raw = readJsonFile(join(this.dir, name)) ?? {}
      const unit = str(raw.unit)
      const runtimeSessionId = str(raw.runtimeSessionId)
      const rootStreamId = str(raw.rootStreamId)
      return unit && runtimeSessionId ? [{ unit, runtimeSessionId, ...(rootStreamId ? { rootStreamId } : {}) }] : []
    })
  }

  /** Records the unit, then disables and stops it. `--no-block`: the stop job SIGTERMs this very process. */
  sleep(record: HibernationRecord): void {
    const rootStreamId = record.rootStreamId ?? this.find(record.unit)?.rootStreamId
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileAtomic(
      this.path(record.unit),
      `${JSON.stringify({ ...record, ...(rootStreamId ? { rootStreamId } : {}) })}\n`
    )
    this.systemctl(["disable", record.unit])
    this.systemctl(["stop", "--no-block", record.unit])
  }

  /** The unit linked again: enabled first, so a failed enable leaves the record for the next link to retry. */
  wake(unit: string): boolean {
    if (!this.find(unit)) return false
    this.systemctl(["enable", unit])
    rmSync(this.path(unit), { force: true })
    return true
  }

  private find(unit: string): HibernationRecord | undefined {
    return this.list().find((record) => record.unit === unit)
  }

  private path(unit: string): string {
    return join(this.dir, `${unit}.json`)
  }
}
