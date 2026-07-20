import { spawnSync as nodeSpawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface HarnessKickResult {
  ok: boolean
  error?: string
}

interface HarnessSpawnResult {
  status: number | null
  stdout?: string | Buffer | null
  stderr?: string | Buffer | null
  error?: Error
}

type HarnessSpawnSync = (executable: string, args: string[], options: { encoding: "utf8" }) => HarnessSpawnResult

interface RunHarnessKickOptions {
  entrypoint?: string
  bunExecutable?: string
  exists?: (path: string) => boolean
  spawnSync?: HarnessSpawnSync
}

export function harnessDaemonEntrypoint(): string {
  return (
    process.env.THREA_HARNESSD_ENTRYPOINT?.trim() ||
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "harness-daemon", "src", "index.ts")
  )
}

/** Ask harnessd to nudge one managed runtime's tmux pane with Enter. */
export function runHarnessKick(runtimeSessionId: string, options: RunHarnessKickOptions = {}): HarnessKickResult {
  const ref = runtimeSessionId.trim()
  if (!ref) return { ok: false, error: "Runtime session id is missing." }

  const entrypoint = options.entrypoint ?? harnessDaemonEntrypoint()
  if (!(options.exists ?? existsSync)(entrypoint)) {
    return { ok: false, error: `Harness daemon entrypoint not found: ${entrypoint}` }
  }

  try {
    const bunExecutable = (options.bunExecutable ?? process.env.THREA_HARNESSD_BUN_BIN?.trim()) || "bun"
    const result = (options.spawnSync ?? nodeSpawnSync)(bunExecutable, [entrypoint, "kick", ref], {
      encoding: "utf8",
    })
    if (result.error) return { ok: false, error: result.error.message }
    if (result.status === 0) return { ok: true }
    const detail = String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()
    return { ok: false, error: detail || `Harness daemon exited ${result.status ?? "without a status"}.` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
