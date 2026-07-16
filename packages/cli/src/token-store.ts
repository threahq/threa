import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

interface StateShape {
  claimTokens: Record<string, Record<string, string>>
}

function defaultPath(): string {
  return process.env.THREA_STATE_FILE ?? join(homedir(), ".threa", "state.json")
}

export class TokenStore {
  private readonly path: string
  private state: StateShape = { claimTokens: {} }
  private loaded = false

  constructor(pathOverride?: string) {
    this.path = pathOverride ?? defaultPath()
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = readFileSync(this.path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(
          `[threa] state file ${this.path} could not be read; starting with an empty claim-token store\n`
        )
      }
      return
    }
    try {
      const parsed = JSON.parse(raw) as { claimTokens?: unknown }
      if (parsed && typeof parsed.claimTokens === "object" && parsed.claimTokens !== null) {
        this.state = { claimTokens: parsed.claimTokens as Record<string, Record<string, string>> }
      }
    } catch {
      process.stderr.write(`[threa] state file ${this.path} is corrupt; starting with an empty claim-token store\n`)
    }
  }

  get(workspaceId: string, delegationId: string): string | undefined {
    this.load()
    return this.state.claimTokens[workspaceId]?.[delegationId]
  }

  set(workspaceId: string, delegationId: string, token: string): void {
    this.load()
    ;(this.state.claimTokens[workspaceId] ??= {})[delegationId] = token
    this.persist()
  }

  delete(workspaceId: string, delegationId: string): void {
    this.load()
    const ws = this.state.claimTokens[workspaceId]
    if (!ws?.[delegationId]) return
    delete ws[delegationId]
    if (Object.keys(ws).length === 0) delete this.state.claimTokens[workspaceId]
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
