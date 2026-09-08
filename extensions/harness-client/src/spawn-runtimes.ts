import { spawnSync as nodeSpawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { harnessDaemonEntrypoint, type HarnessSpawnSync } from "./harness-kick"

export interface SpawnRuntimeOption {
  value: string
  label: string
  installed: boolean
  /** Levels this runtime's binary accepts at launch; the spawn picker offers exactly these. */
  thinkingLevels: string[]
  description?: string
}

/** The picker rows for the runtimes this machine can launch, without the `installed` flag. */
export function installedSpawnRuntimes(
  runtimes: readonly SpawnRuntimeOption[]
): { value: string; label: string; thinkingLevels: string[]; description?: string }[] {
  return runtimes.filter((runtime) => runtime.installed).map(({ installed: _, ...option }) => option)
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
  if (typeof candidate.installed !== "boolean") return false
  if (!Array.isArray(candidate.thinkingLevels) || !candidate.thinkingLevels.every((l) => typeof l === "string")) {
    return false
  }
  if (candidate.description !== undefined && typeof candidate.description !== "string") return false
  return true
}

/** Ask harnessd which runtimes it knows and which of them this machine has. No harness = nothing spawnable. */
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

/**
 * Resolved once per process, like model suggestions: a runtime installed later
 * shows up with the next session. A failed lookup is reported once and stays
 * empty rather than re-running harnessd on every capability build.
 */
export function spawnRuntimesResolver(
  onError: (error: string) => void,
  options: ListSpawnRuntimesOptions = {}
): () => SpawnRuntimeOption[] {
  let cached: SpawnRuntimeOption[] | undefined
  return () => {
    if (cached) return cached
    const result = listSpawnRuntimes(options)
    if (result.ok) {
      cached = result.runtimes
    } else {
      onError(result.error)
      cached = []
    }
    return cached
  }
}
