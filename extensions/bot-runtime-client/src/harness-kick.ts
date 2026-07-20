import { existsSync } from "node:fs"
import { join } from "node:path"

export interface HarnessKickResult {
  ok: boolean
  error?: string
}

interface RunHarnessKickOptions {
  entrypoint?: string
  exists?: (path: string) => boolean
  spawnSync?: typeof Bun.spawnSync
}

export function harnessDaemonEntrypoint(): string {
  return (
    process.env.THREA_HARNESSD_ENTRYPOINT?.trim() ||
    join(import.meta.dir, "..", "..", "harness-daemon", "src", "index.ts")
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
    const result = (options.spawnSync ?? Bun.spawnSync)([process.execPath, entrypoint, "kick", ref], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode === 0) return { ok: true }
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim()
    return { ok: false, error: detail || `Harness daemon exited ${result.exitCode}.` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
