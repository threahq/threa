import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

interface StateShape {
  claimTokens: Record<string, Record<string, string>>
}

const LOCK_WAIT_MS = 5_000

function defaultPath(): string {
  return process.env.THREA_STATE_FILE ?? join(homedir(), ".threa", "state.json")
}

function emptyState(): StateShape {
  return { claimTokens: {} }
}

export class TokenStore {
  private readonly path: string
  private state: StateShape = emptyState()
  private warned = false

  constructor(pathOverride?: string) {
    this.path = pathOverride ?? defaultPath()
  }

  private readState(): StateShape {
    let raw: string
    try {
      raw = readFileSync(this.path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warnOnce(`[threa] state file ${this.path} could not be read; starting with an empty claim-token store\n`)
      }
      return emptyState()
    }
    try {
      const parsed = JSON.parse(raw) as { claimTokens?: unknown }
      if (parsed && typeof parsed.claimTokens === "object" && parsed.claimTokens !== null) {
        return { claimTokens: parsed.claimTokens as Record<string, Record<string, string>> }
      }
    } catch {
      this.warnOnce(`[threa] state file ${this.path} is corrupt; starting with an empty claim-token store\n`)
    }
    return emptyState()
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    process.stderr.write(message)
  }

  get(workspaceId: string, delegationId: string): string | undefined {
    this.state = this.readState()
    return this.state.claimTokens[workspaceId]?.[delegationId]
  }

  set(workspaceId: string, delegationId: string, token: string): void {
    this.mutate((state) => {
      ;(state.claimTokens[workspaceId] ??= {})[delegationId] = token
      return true
    })
  }

  delete(workspaceId: string, delegationId: string): void {
    this.mutate((state) => this.remove(state, workspaceId, delegationId))
  }

  deleteIfMatches(workspaceId: string, delegationId: string, observedToken: string): boolean {
    return this.mutate((state) => {
      if (state.claimTokens[workspaceId]?.[delegationId] !== observedToken) return false
      this.remove(state, workspaceId, delegationId)
      return true
    })
  }

  private remove(state: StateShape, workspaceId: string, delegationId: string): boolean {
    const ws = state.claimTokens[workspaceId]
    if (ws?.[delegationId] === undefined) return false
    delete ws[delegationId]
    if (Object.keys(ws).length === 0) delete state.claimTokens[workspaceId]
    return true
  }

  private mutate<T>(change: (state: StateShape) => T): T {
    const unlock = this.lock()
    try {
      const state = this.readState()
      const result = change(state)
      this.state = state
      if (result !== false) this.persist(state)
      return result
    } finally {
      unlock()
    }
  }

  private lock(): () => void {
    mkdirSync(dirname(this.path), { recursive: true })
    const lockPath = `${this.path}.lock.sqlite`
    const db = new Database(lockPath, { create: true })
    try {
      chmodSync(lockPath, 0o600)
      db.run(`PRAGMA busy_timeout = ${LOCK_WAIT_MS}`)
      db.run("BEGIN IMMEDIATE")
    } catch (error) {
      db.close()
      throw error
    }

    return () => {
      try {
        db.run("COMMIT")
      } finally {
        db.close()
      }
    }
  }

  private persist(state: StateShape): void {
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
