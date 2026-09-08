import { spawnSync as nodeSpawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { harnessDaemonEntrypoint, type HarnessSpawnSync } from "./harness-kick"

export interface SpawnRuntimeOption {
  value: string
  label: string
  description?: string
}

interface ListSpawnRuntimesOptions {
  entrypoint?: string
  bunExecutable?: string
  exists?: (path: string) => boolean
  spawnSync?: HarnessSpawnSync
}

export type ListSpawnRuntimesResult = { ok: true; runtimes: SpawnRuntimeOption[] } | { ok: false; error: string }

function isSpawnRuntimeOption(value: unknown): value is SpawnRuntimeOption {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.value !== "string" || typeof candidate.label !== "string") return false
  if (candidate.description !== undefined && typeof candidate.description !== "string") return false
  return true
}

/** Ask harnessd for the spawnable runtimes installed on this machine. No harness = nothing spawnable. */
export function listSpawnRuntimes(options: ListSpawnRuntimesOptions = {}): ListSpawnRuntimesResult {
  const entrypoint = options.entrypoint ?? harnessDaemonEntrypoint()
  if (!(options.exists ?? existsSync)(entrypoint)) return { ok: true, runtimes: [] }

  try {
    const bunExecutable = (options.bunExecutable ?? process.env.THREA_HARNESSD_BUN_BIN?.trim()) || "bun"
    const result = (options.spawnSync ?? nodeSpawnSync)(bunExecutable, [entrypoint, "runtimes"], {
      encoding: "utf8",
    })
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status !== 0) {
      const detail = String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()
      return { ok: false, error: detail || `Harness daemon exited ${result.status ?? "without a status"}.` }
    }
    const stdout = String(result.stdout ?? "").trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      return { ok: false, error: `harnessd runtimes returned unparseable output: ${stdout}` }
    }
    if (!Array.isArray(parsed) || !parsed.every(isSpawnRuntimeOption)) {
      return { ok: false, error: `harnessd runtimes returned unexpected output: ${stdout}` }
    }
    return { ok: true, runtimes: parsed }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
