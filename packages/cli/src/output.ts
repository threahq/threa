import type { ParseArgsConfig } from "node:util"
import { OUTPUT_MODES, type OutputMode, type ThreaConfig } from "./config"
import type { ThreaApiClient } from "./api-client"
import type { RefResolver } from "./resolver"
import type { TokenStore } from "./token-store"
import { toErrorShape, type ErrorShape } from "./tools/result"

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export interface CommandContext {
  client: ThreaApiClient
  resolver: RefResolver
  config: ThreaConfig
  tokenStore: TokenStore
  /** Reads piped stdin for a `-` content arg. Injectable so tests feed content without a real pipe. */
  readStdin: () => Promise<string>
}

export type ParseOptions = NonNullable<ParseArgsConfig["options"]>

export interface CommandSpec {
  name: string
  summary: string
  usage: string
  help: string
  options: ParseOptions
  /** `mcp serve` runs a long-lived server the run() seam cannot buffer. */
  serve?: boolean
  /** Command needs no workspace config (no API calls) — run() skips loadConfig. */
  noConfig?: boolean
  run(ctx: CommandContext, positionals: string[], values: Record<string, unknown>): Promise<unknown>
  render?(payload: unknown): string
}

/** One verb under a noun (`threa <noun> <verb>`): its own flags, help, and run. */
export interface VerbSpec {
  name: string
  summary: string
  usage: string
  help: string
  options: ParseOptions
  run(ctx: CommandContext, positionals: string[], values: Record<string, unknown>): Promise<unknown>
  render?(payload: unknown): string
}

/** A noun command that owns named verb subcommands (`threa messages send …`). */
export interface NounSpec {
  name: string
  summary: string
  verbs: VerbSpec[]
}

export type ErrorObject = ErrorShape

export const errorObject = toErrorShape

export function formatSuccess(
  spec: { render?(payload: unknown): string },
  payload: unknown,
  opts: { mode: OutputMode }
): string {
  if (opts.mode === "json" || !spec.render) return JSON.stringify(payload, null, 2)
  try {
    return spec.render(payload)
  } catch {
    return JSON.stringify(payload, null, 2)
  }
}

const GLOBAL_OPTIONS: ParseOptions = {
  help: { type: "boolean", short: "h" },
}

/**
 * Pulls the position-independent output flags (`--json`, `-o/--output json|text`)
 * out of argv before command routing, so `threa --json streams list` works the
 * same as `threa streams list --json`. Everything after a literal `--` is left
 * untouched. Later flags win when both forms appear.
 */
export function extractOutputMode(argv: string[]): { argv: string[]; mode?: OutputMode } {
  const rest: string[] = []
  let mode: OutputMode | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") {
      rest.push(...argv.slice(i))
      break
    }
    if (token === "--json") {
      mode = "json"
      continue
    }
    let value: string | undefined
    if (token === "-o" || token === "--output") {
      value = argv[++i]
      if (value === undefined) throw new UsageError(`${token} requires a value: ${OUTPUT_MODES.join("|")}`)
    } else if (token.startsWith("-o=") || token.startsWith("--output=")) {
      value = token.slice(token.indexOf("=") + 1)
    } else {
      rest.push(token)
      continue
    }
    if (!(OUTPUT_MODES as readonly string[]).includes(value)) {
      throw new UsageError(`-o/--output must be one of ${OUTPUT_MODES.join("|")}, got "${value}"`)
    }
    mode = value as OutputMode
  }
  return { argv: rest, mode }
}

export function withGlobalOptions(options: ParseOptions): ParseOptions {
  return { ...options, ...GLOBAL_OPTIONS }
}

export function intFlag(values: Record<string, unknown>, name: string): number | undefined {
  const v = values[name]
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`--${name} must be a positive integer, got "${String(v)}"`)
  }
  return n
}

export function stringFlag(values: Record<string, unknown>, name: string): string | undefined {
  const v = values[name]
  return typeof v === "string" ? v : undefined
}

export function boolFlag(values: Record<string, unknown>, name: string): boolean {
  return values[name] === true
}

export function arrayFlag(values: Record<string, unknown>, name: string): string[] | undefined {
  const v = values[name]
  if (Array.isArray(v) && v.length > 0) return v as string[]
  return undefined
}

export function kvPairs(pairs: string[], label = "metadata"): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf("=")
    if (eq <= 0) throw new UsageError(`${label} must be key=value, got "${pair}"`)
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

/** Formats a JSON error object as the single stderr line-block both error paths emit. */
export function stderrJson(obj: ErrorObject): string {
  return `${JSON.stringify(obj, null, 2)}\n`
}

export function enumFlag<T extends string>(
  values: Record<string, unknown>,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const v = stringFlag(values, name)
  if (v === undefined) return undefined
  if (!(allowed as readonly string[]).includes(v)) {
    throw new UsageError(`--${name} must be one of ${allowed.join("|")}, got "${v}"`)
  }
  return v as T
}

export function enumArrayFlag<T extends string>(
  values: Record<string, unknown>,
  name: string,
  allowed: readonly T[]
): T[] | undefined {
  const arr = arrayFlag(values, name)
  if (arr === undefined) return undefined
  for (const v of arr) {
    if (!(allowed as readonly string[]).includes(v)) {
      throw new UsageError(`--${name} must be one of ${allowed.join("|")}, got "${v}"`)
    }
  }
  return arr as T[]
}

/** ISO datetime → local `YYYY-MM-DD HH:mm` for human text output; "" when absent/invalid. */
export function fmtTimestamp(iso: unknown): string {
  if (typeof iso !== "string") return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

interface RenderStreamRef {
  id?: string
  name?: string
}

/** `root › stream` scope label from enriched stream refs; falls back to ids, "" when unenriched. */
export function streamLabel(row: {
  stream?: RenderStreamRef
  rootStream?: RenderStreamRef
  streamId?: unknown
}): string {
  const name = row.stream?.name ?? row.stream?.id ?? (typeof row.streamId === "string" ? row.streamId : undefined)
  if (!name) return ""
  const root = row.rootStream?.name ?? row.rootStream?.id
  return root && root !== name ? `${root} › ${name}` : name
}

/** Collapses whitespace and truncates for one-line previews. */
export function snippet(text: unknown, max = 160): string {
  if (typeof text !== "string") return ""
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

export function cursorFooter(p: { hasMore?: boolean; cursor?: string | null }, flag: string): string[] {
  return p.hasMore && p.cursor ? [`… more (--${flag} ${p.cursor})`] : []
}

export function renderList<T>(
  payload: unknown,
  formatRow: (row: T) => string,
  opts: { empty: string; cursorFlag?: string }
): string {
  const p = payload as { data?: T[]; hasMore?: boolean; cursor?: string | null }
  const lines = (p.data ?? []).map(formatRow)
  if (opts.cursorFlag) lines.push(...cursorFooter(p, opts.cursorFlag))
  return lines.join("\n") || opts.empty
}
