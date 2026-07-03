import { createHash } from "node:crypto"

export interface RemoteSessionConfig {
  baseUrl: string
  workspaceId: string
  apiKey: string
  /** Scratchpad display name: the configured prefix with the project directory appended. */
  displayName: string
  /** Sent as `labelName` on session create; the backend applies it only to a newly created scratchpad. Unset = no label. */
  defaultLabel?: string
  /** `^[A-Za-z0-9_-]+$`, ≤64 — must satisfy the `/bot` hello schema. */
  instanceId: string
  runtimeSessionId: string
  /** Relay the runtime's tool-approval prompts into the scratchpad for remote approval. */
  permissionRelay: boolean
  /** Backstop claim-poll cadence; the `/bot` socket pushes work faster than this. */
  pollMs: number
  /**
   * Safety net for a wedged turn: an in-flight invocation is force-closed after
   * this much *inactivity*. Every interim send (and tool-approval activity)
   * resets it, so an actively-working turn never trips it — only one that went
   * silent without a reply. Must exceed the longest single tool call the agent
   * makes, since it can't heartbeat while blocked on a tool.
   */
  idleTimeoutMs: number
  /**
   * Where this install's BIK (Bot Identity Key, for sealed/E2EE scratchpads)
   * is persisted. Unset = a per-runtime-kind default under `~/.threa/`.
   * Deleting the file orphans the owner's key wraps — the owner must re-invite
   * the bot after it registers a fresh key.
   */
  bikPath?: string
  /**
   * Create this connector's linked scratchpad end-to-end encrypted: the harness
   * mints the stream key and wraps it to the bot owner's UIK + its own BIK, so
   * the server only ever stores ciphertext. Requires the owner to have set up
   * encryption in Threa (their UIK is fetched at session create). Off by
   * default — an encrypted scratchpad opts out of GAM memory extraction.
   */
  e2e?: boolean
}

/**
 * Who this connector is: the stable-id prefixes that key its sessions and the
 * default display-name prefix. Every connector picks its own (Claude Code uses
 * cc/ccs), so two runtimes in the same directory never collide.
 */
export interface ConnectorIdentity {
  /** Prefix for the derived instance id (e.g. "cc"). */
  idPrefix: string
  /** Prefix for the derived runtime-session id (e.g. "ccs"). */
  sessionIdPrefix: string
  /** Human prefix for the scratchpad display name (e.g. "Claude Code"). */
  displayNamePrefix: string
  /** Where the connector reads file config from — used only in the missing-config error message. */
  configPathHint?: string
}

const UNSAFE_ID_CHARS = /[^A-Za-z0-9_-]+/g

export function sanitizeId(raw: string): string {
  return raw.replace(UNSAFE_ID_CHARS, "-").replace(/^-+|-+$/g, "")
}

/**
 * Deterministic id from a seed (host + cwd), so the same project directory
 * always maps back to the same Threa scratchpad across runtime restarts —
 * no on-disk session state to keep in sync.
 */
export function deriveStableId(prefix: string, seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 16)
  return `${prefix}-${hash}`.slice(0, 64)
}

export function defaultDisplayName(cwd: string, prefix: string, override?: string): string {
  const effective = override?.trim() ? override.trim() : prefix
  const dir = cwd.split("/").filter(Boolean).pop() ?? "session"
  const name = `${effective} - ${dir}`
  // upsertPresenceSchema caps displayName at 100 chars.
  return name.length > 100 ? name.slice(0, 100) : name
}

export interface RawConfig {
  baseUrl?: unknown
  workspaceId?: unknown
  apiKey?: unknown
  displayName?: unknown
  defaultLabel?: unknown
  permissionRelay?: unknown
  pollMs?: unknown
  idleTimeoutMs?: unknown
  instanceId?: unknown
  runtimeSessionId?: unknown
  bikPath?: unknown
  e2e?: unknown
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

export type LoadConfigResult = { config: RemoteSessionConfig } | { error: string }

/**
 * Pure config resolver: file values are the base, environment variables win.
 * Kept side-effect-free so it can be unit-tested without touching disk/env.
 */
export function loadConfig(input: LoadConfigInput, identity: ConnectorIdentity): LoadConfigResult {
  const { env, cwd, hostname, file = {} } = input

  const baseUrl = str(env.THREA_BASE_URL) ?? str(file.baseUrl) ?? "https://app.threa.io"
  const workspaceId = str(env.THREA_WORKSPACE_ID) ?? str(file.workspaceId)
  const apiKey = str(env.THREA_API_KEY) ?? str(file.apiKey)

  const missing = [!workspaceId && "THREA_WORKSPACE_ID", !apiKey && "THREA_API_KEY"].filter(Boolean)
  if (missing.length > 0) {
    const hint = identity.configPathHint ? ` or ${identity.configPathHint}` : ""
    return { error: `Missing required config: ${missing.join(", ")}. Set env vars${hint}.` }
  }

  const displayName = defaultDisplayName(
    cwd,
    identity.displayNamePrefix,
    str(env.THREA_DISPLAY_NAME) ?? str(file.displayName)
  )
  const defaultLabel = str(env.THREA_DEFAULT_LABEL) ?? str(file.defaultLabel)
  const seed = `${hostname}:${cwd}`
  const instanceId = sanitizeId(
    str(env.THREA_INSTANCE_ID) ?? str(file.instanceId) ?? deriveStableId(identity.idPrefix, seed)
  ).slice(0, 64)
  const runtimeSessionId = sanitizeId(
    str(env.THREA_RUNTIME_SESSION_ID) ?? str(file.runtimeSessionId) ?? deriveStableId(identity.sessionIdPrefix, seed)
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
      defaultLabel,
      instanceId,
      runtimeSessionId,
      permissionRelay: parseBool(env.THREA_PERMISSION_RELAY ?? file.permissionRelay, true),
      pollMs: parseNum(env.THREA_POLL_MS ?? file.pollMs, 3000, 1000),
      idleTimeoutMs: parseNum(env.THREA_IDLE_TIMEOUT_MS ?? file.idleTimeoutMs, 3_600_000, 60_000),
      bikPath: str(env.THREA_BIK_PATH) ?? str(file.bikPath),
      e2e: parseBool(env.THREA_E2E ?? file.e2e, false),
    },
  }
}
