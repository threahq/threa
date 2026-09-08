import { randomUUID } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface SpawnCommandArgs {
  runtime?: string
  name: string
  prompt: string
}

export function parseSpawnCommandArgs(args: string, runtimes: readonly string[]): SpawnCommandArgs | { error: string } {
  const lines = args.split(/\r?\n/)
  const tokens = (lines[0] ?? "").split(/\s+/).filter(Boolean)
  const runtime = tokens[0] && runtimes.includes(tokens[0]) ? tokens[0] : undefined
  const nameTokens = runtime ? tokens.slice(1) : tokens
  const usage =
    runtimes.length > 0
      ? `Usage: \`/spawn [${runtimes.join("|")}] <name>\` with the prompt on the following lines.`
      : "Usage: `/spawn <name>` with the prompt on the following lines."
  // A leading dash would reach harnessd as a flag, which dies with a parser error instead of this usage.
  if (nameTokens.length === 0 || nameTokens.some((token) => token.startsWith("-"))) return { error: usage }
  const name = nameTokens.join(" ")
  return { ...(runtime ? { runtime } : {}), name, prompt: lines.slice(1).join("\n").trim() }
}

/** harnessd reads the brief once and unlinks it; only a launch that never reached harnessd needs {@link discardSpawnBrief}. */
export function writeSpawnBrief(prompt: string, options: { dir?: string } = {}): string {
  const path = join(options.dir ?? tmpdir(), `threa-spawn-${randomUUID()}.md`)
  writeFileSync(path, prompt, { flag: "wx", mode: 0o600 })
  return path
}

export function discardSpawnBrief(path: string | undefined): void {
  if (!path) return
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or never written; the caller is on a failure path already.
  }
}
