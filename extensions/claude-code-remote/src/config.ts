import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

export const CONFIG_DIR = join(homedir(), ".claude", "threa-channel")
export const CONFIG_PATH = join(CONFIG_DIR, "config.json")

export interface ThreaChannelConfig {
  baseUrl: string
  workspaceId: string
  apiKey: string
  /** Scratchpad display name: the configured prefix (default "Claude Code") with the project directory appended. */
  displayName: string
  /** `^[A-Za-z0-9_-]+$`, ≤64 — must satisfy the `/bot` hello schema. */
  instanceId: string
  runtimeSessionId: string
  /** Relay Claude Code permission prompts into the scratchpad for remote approval. */
  permissionRelay: boolean
  /** Backstop claim-poll cadence; the `/bot` socket pushes work faster than this. */
  pollMs: number
  /** Safety net: an in-flight invocation with no `reply` is force-closed after this. */
  replyTimeoutMs: number
}

const UNSAFE_ID_CHARS = /[^A-Za-z0-9_-]+/g

export function sanitizeId(raw: string): string {
  return raw.replace(UNSAFE_ID_CHARS, "-").replace(/^-+|-+$/g, "")
}

/**
 * Deterministic id from a seed (host + cwd), so the same project directory
 * always maps back to the same Threa scratchpad across Claude Code restarts —
 * no on-disk session state to keep in sync.
 */
export function deriveStableId(prefix: string, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16)
  return `${prefix}-${hash}`.slice(0, 64)
}

export function defaultDisplayName(cwd: string, override?: string): string {
  const prefix = override?.trim() ? override.trim() : "Claude Code"
  const dir = cwd.split("/").filter(Boolean).pop() ?? "session"
  const name = `${prefix} - ${dir}`
  // upsertPresenceSchema caps displayName at 100 chars.
  return name.length > 100 ? name.slice(0, 100) : name
}

export interface RawConfig {
  baseUrl?: unknown
  workspaceId?: unknown
  apiKey?: unknown
  displayName?: unknown
  permissionRelay?: unknown
  pollMs?: unknown
  replyTimeoutMs?: unknown
  instanceId?: unknown
  runtimeSessionId?: unknown
}

export function parseConfigFile(text: string): RawConfig {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config file must be a JSON object")
  }
  return parsed as RawConfig
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  const s = str(value)?.toLowerCase()
  if (s === undefined) return fallback
  if (["0", "false", "no", "off"].includes(s)) return false
  if (["1", "true", "yes", "on"].includes(s)) return true
  return fallback
}

function parseNum(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" ? value : Number(str(value))
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback
}

export interface LoadConfigInput {
  env: Record<string, string | undefined>
  cwd: string
  hostname: string
  file?: RawConfig
}

export type LoadConfigResult = { config: ThreaChannelConfig } | { error: string }

/**
 * Pure config resolver: file values are the base, environment variables win.
 * Kept side-effect-free so it can be unit-tested without touching disk/env.
 */
export function loadConfig(input: LoadConfigInput): LoadConfigResult {
  const { env, cwd, hostname, file = {} } = input

  const baseUrl = str(env.THREA_BASE_URL) ?? str(file.baseUrl) ?? "https://app.threa.io"
  const workspaceId = str(env.THREA_WORKSPACE_ID) ?? str(file.workspaceId)
  const apiKey = str(env.THREA_API_KEY) ?? str(file.apiKey)

  const missing = [!workspaceId && "THREA_WORKSPACE_ID", !apiKey && "THREA_API_KEY"].filter(Boolean)
  if (missing.length > 0) {
    return { error: `Missing required config: ${missing.join(", ")}. Set env vars or ${CONFIG_PATH}.` }
  }

  const displayName = defaultDisplayName(cwd, str(env.THREA_DISPLAY_NAME) ?? str(file.displayName))
  const seed = `${hostname}:${cwd}`
  const instanceId = sanitizeId(str(env.THREA_INSTANCE_ID) ?? str(file.instanceId) ?? deriveStableId("cc", seed)).slice(
    0,
    64
  )
  const runtimeSessionId = sanitizeId(
    str(env.THREA_RUNTIME_SESSION_ID) ?? str(file.runtimeSessionId) ?? deriveStableId("ccs", seed)
  ).slice(0, 64)

  if (!instanceId || !runtimeSessionId) {
    return { error: "Could not derive a valid instanceId/runtimeSessionId (empty after sanitization)." }
  }

  return {
    config: {
      baseUrl: baseUrl.replace(/\/$/, ""),
      workspaceId: workspaceId!,
      apiKey: apiKey!,
      displayName,
      instanceId,
      runtimeSessionId,
      permissionRelay: parseBool(env.THREA_PERMISSION_RELAY ?? file.permissionRelay, true),
      pollMs: parseNum(env.THREA_POLL_MS ?? file.pollMs, 3000, 1000),
      replyTimeoutMs: parseNum(env.THREA_REPLY_TIMEOUT_MS ?? file.replyTimeoutMs, 1_800_000, 60_000),
    },
  }
}
