import { randomUUID } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnRuntimeOption } from "./spawn-runtimes"

interface SpawnCommandArgs {
  runtime: string
  name: string
  prompt: string
  model?: string
  thinking?: string
}

interface ParseSpawnCommandOptions {
  /** harnessd's catalog: a known runtime that is not installed is refused, never folded into the name. */
  runtimes: readonly SpawnRuntimeOption[]
  /** Used when the first token is not a runtime; must itself be installed. */
  defaultRuntime: string
}

export function parseSpawnCommandArgs(
  args: string,
  options: ParseSpawnCommandOptions
): SpawnCommandArgs | { error: string } {
  const lines = args.split(/\r?\n/)
  const tokens = (lines[0] ?? "").split(/\s+/).filter(Boolean)
  const installed = options.runtimes.filter((runtime) => runtime.installed)
  const leading = options.runtimes.find((runtime) => runtime.value === tokens[0])
  const runtime = leading?.value ?? options.defaultRuntime
  const chosen = installed.find((option) => option.value === runtime)
  if (!chosen) {
    const available = installed.length > 0 ? ` Installed: ${installed.map((one) => one.value).join(", ")}.` : ""
    return { error: `\`${runtime}\` is not installed on this machine.${available}` }
  }
  const rest = leading ? tokens.slice(1) : tokens
  const usage =
    installed.length > 0
      ? `Usage: \`/spawn [${installed.map((one) => one.value).join("|")}] [--model <model>] [--thinking <level>] <name>\` with the prompt on the following lines.`
      : "Usage: `/spawn [--model <model>] [--thinking <level>] <name>` with the prompt on the following lines."
  const nameTokens: string[] = []
  let model: string | undefined
  let thinking: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string
    if (token === "--model" || token === "--thinking") {
      const value = rest[index + 1]
      if (!value || value.startsWith("-")) return { error: `\`${token}\` needs a value. ${usage}` }
      index += 1
      if (token === "--model") model = value
      else thinking = value.toLowerCase()
      continue
    }
    // A leading dash would reach harnessd as a flag, which dies with a parser error instead of this usage.
    if (token.startsWith("-")) return { error: usage }
    nameTokens.push(token)
  }
  if (nameTokens.length === 0) return { error: usage }
  if (thinking && !chosen.thinkingLevels.includes(thinking)) {
    return {
      error: `\`${runtime}\` takes \`--thinking\` ${chosen.thinkingLevels.join(", ")}; set anything else in the session.`,
    }
  }
  return {
    runtime,
    name: nameTokens.join(" "),
    prompt: lines.slice(1).join("\n").trim(),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  }
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
