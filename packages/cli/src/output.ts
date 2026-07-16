import type { ParseArgsConfig } from "node:util"
import type { ThreaMcpConfig } from "./config"
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
  config: ThreaMcpConfig
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
  opts: { json: boolean; isTTY: boolean }
): string {
  if (opts.json || !opts.isTTY || !spec.render) return JSON.stringify(payload, null, 2)
  try {
    return spec.render(payload)
  } catch {
    return JSON.stringify(payload, null, 2)
  }
}

const GLOBAL_OPTIONS: ParseOptions = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
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
