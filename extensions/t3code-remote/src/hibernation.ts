import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { writeFileAtomic } from "@threahq/remote-session"
import { readJsonFile, str } from "./config"

export interface HibernationRecord {
  unit: string
  runtimeSessionId: string
  /** Unknown when a cold start was refused without a pinned root: the server does not name it. */
  rootStreamId?: string
}

export type Systemctl = (args: string[]) => void

export const systemctlUser: Systemctl = (args) => {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" })
  if (result.error) throw new Error(`systemctl --user ${args.join(" ")} failed: ${result.error.message}`)
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
    private readonly systemctl: Systemctl,
    private readonly log: (message: string) => void
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
      try {
        return this.read(join(this.dir, name)) ?? []
      } catch (error) {
        // One damaged record must not strand every other hibernating unit.
        this.log(`skipping hibernation record: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    })
  }

  find(unit: string): HibernationRecord | undefined {
    return this.read(this.path(unit))
  }

  /** Records the unit, then disables and stops it. `--no-block`: the stop job SIGTERMs this very process. */
  hibernate(record: HibernationRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileAtomic(this.path(record.unit), `${JSON.stringify(record)}\n`)
    this.systemctl(["disable", record.unit])
    this.systemctl(["stop", "--no-block", record.unit])
  }

  /** The unit linked again: enabled first, so a failed enable keeps the record and the waker can still start it. */
  release(unit: string): boolean {
    if (!this.find(unit)) return false
    this.systemctl(["enable", unit])
    rmSync(this.path(unit), { force: true })
    return true
  }

  private read(path: string): HibernationRecord | undefined {
    const raw = readJsonFile(path)
    const unit = str(raw?.unit)
    const runtimeSessionId = str(raw?.runtimeSessionId)
    const rootStreamId = str(raw?.rootStreamId)
    return unit && runtimeSessionId ? { unit, runtimeSessionId, ...(rootStreamId ? { rootStreamId } : {}) } : undefined
  }

  private path(unit: string): string {
    return join(this.dir, `${unit}.json`)
  }
}

export interface UnitHibernation {
  /** The scratchpad this unit hibernated on, when its record names one. */
  readonly root: string | undefined
  /** Records, disables and stops the unit; false when that failed and the connector must wait in-process. */
  hibernate(rootStreamId?: string): boolean
  /** The unit linked again: enable it and drop its record. */
  linked(): void
}

/** One connector's hibernation: at most once per process, and never undone by a link racing the stop. */
export function unitHibernation(
  store: Hibernation,
  unit: string,
  runtimeSessionId: string,
  log: (message: string) => void
): UnitHibernation {
  let hibernating = false
  const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
  return {
    root: store.find(unit)?.rootStreamId,
    hibernate: (rootStreamId) => {
      if (hibernating) return true
      try {
        store.hibernate({ unit, runtimeSessionId, ...(rootStreamId ? { rootStreamId } : {}) })
        hibernating = true
        log(`scratchpad ${rootStreamId ?? "for this session"} archived; hibernating ${unit} until it is restored`)
      } catch (error) {
        log(`hibernating ${unit} failed: ${messageOf(error)}`)
      }
      return hibernating
    },
    linked: () => {
      if (hibernating) return
      try {
        if (store.release(unit)) log(`linked again; ${unit} enabled`)
      } catch (error) {
        log(`re-enabling ${unit} failed: ${messageOf(error)}`)
      }
    },
  }
}
