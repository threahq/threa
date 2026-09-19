import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  E2E_KEY_SCOPES,
  E2E_KEY_STORE_KINDS,
  type E2eKeyScope,
  type E2eKeyStoreKind,
} from "../../../extensions/bot-runtime-client/src/keyring"

export const OUTPUT_MODES = ["text", "json"] as const
export type OutputMode = (typeof OUTPUT_MODES)[number]

export const PRINCIPAL_KINDS = ["bot", "user"] as const
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number]

export interface ThreaConfig {
  apiKey: string
  workspaceId: string
  baseUrl: string
  output: OutputMode
  principal?: PrincipalKind
  /**
   * Which key a bot principal reads sealed streams with, mirroring the
   * connector setting of the same name: the CLI must address the account the
   * runtime that owns this key filed it under, or it looks in the wrong place.
   * Unused by a user principal, whose key is filed under their own account.
   */
  keyScope?: E2eKeyScope
  keyStore?: E2eKeyStoreKind
  keyDir?: string
  /** The runtime install this key belongs to. Required by `keyScope: "instance"`. */
  instanceId?: string
}

const DEFAULT_BASE_URL = "https://app.threa.io"

interface FileConfig {
  apiKey?: string
  workspaceId?: string
  baseUrl?: string
  output?: string
  principal?: string
  keyScope?: string
  keyStore?: string
  keyDir?: string
  instanceId?: string
}

function readFileConfig(): FileConfig {
  const explicit = process.env.THREA_CONFIG
  // process.env.HOME first: Bun's homedir() ignores a runtime HOME override,
  // which would leak the developer's real ~/.threa config into tests.
  const home = process.env.HOME ?? homedir()
  const candidates = explicit ? [explicit] : [join(home, ".threa", "config.json"), join(home, ".threa", "mcp.json")]

  let raw: string | undefined
  let path: string | undefined
  for (const candidate of candidates) {
    try {
      raw = readFileSync(candidate, "utf8")
      path = candidate
      break
    } catch {
      // try the next candidate
    }
  }
  if (raw === undefined || path === undefined) {
    if (explicit) {
      throw new Error(`[threa] THREA_CONFIG points to ${explicit}, but it could not be read.`)
    }
    return {}
  }
  if (path.endsWith("mcp.json")) {
    process.stderr.write(`[threa] Using legacy ${path} — rename it to ~/.threa/config.json.\n`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[threa] Config file ${path} is not valid JSON.`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`[threa] Config file ${path} must contain a JSON object with { apiKey, workspaceId, baseUrl }.`)
  }
  return parsed as FileConfig
}

export function loadConfig(): ThreaConfig {
  const file = readFileConfig()

  // A file named by THREA_CONFIG is the caller binding an identity (a runtime's
  // bot key), so it wins over an ambient THREA_API_KEY inherited from a shell.
  const explicit = Boolean(process.env.THREA_CONFIG)
  const apiKey = explicit ? file.apiKey || process.env.THREA_API_KEY : process.env.THREA_API_KEY || file.apiKey
  const workspaceId = explicit
    ? file.workspaceId || process.env.THREA_WORKSPACE_ID
    : process.env.THREA_WORKSPACE_ID || file.workspaceId
  const baseUrl =
    (explicit ? (file.baseUrl ?? process.env.THREA_BASE_URL) : (process.env.THREA_BASE_URL ?? file.baseUrl)) ??
    DEFAULT_BASE_URL
  const output = file.output ?? "text"
  const principal = explicit
    ? (file.principal ?? process.env.THREA_PRINCIPAL)
    : (process.env.THREA_PRINCIPAL ?? file.principal)
  const keyScope = pick(explicit, file.keyScope, process.env.THREA_E2E_KEY_SCOPE)
  const keyStore = pick(explicit, file.keyStore, process.env.THREA_E2E_KEY_STORE)
  const keyDir = pick(explicit, file.keyDir, process.env.THREA_E2E_KEY_DIR)
  const instanceId = pick(explicit, file.instanceId, process.env.THREA_INSTANCE_ID)

  const missing: string[] = []
  if (!apiKey) missing.push("THREA_API_KEY")
  if (!workspaceId) missing.push("THREA_WORKSPACE_ID")
  if (missing.length > 0) {
    throw new Error(
      `[threa] Missing required config: ${missing.join(", ")}. ` +
        `Set them as environment variables, or provide a JSON file at ~/.threa/config.json ` +
        `(or the path in THREA_CONFIG) with { apiKey, workspaceId, baseUrl } and optionally { principal }. ` +
        `Environment variables win over ~/.threa/config.json; a THREA_CONFIG file wins over them.`
    )
  }

  if (!(OUTPUT_MODES as readonly string[]).includes(output)) {
    throw new Error(`[threa] Config "output" must be one of ${OUTPUT_MODES.join(", ")} — got "${output}".`)
  }

  if (principal !== undefined && !(PRINCIPAL_KINDS as readonly string[]).includes(principal)) {
    throw new Error(`[threa] Config "principal" must be one of ${PRINCIPAL_KINDS.join(", ")} — got "${principal}".`)
  }

  if (keyScope !== undefined && !(E2E_KEY_SCOPES as readonly string[]).includes(keyScope)) {
    throw new Error(`[threa] Config "keyScope" must be one of ${E2E_KEY_SCOPES.join(", ")} — got "${keyScope}".`)
  }

  if (keyStore !== undefined && !(E2E_KEY_STORE_KINDS as readonly string[]).includes(keyStore)) {
    throw new Error(`[threa] Config "keyStore" must be one of ${E2E_KEY_STORE_KINDS.join(", ")} — got "${keyStore}".`)
  }

  assertSafeBaseUrl(baseUrl)

  return {
    apiKey: apiKey!,
    workspaceId: workspaceId!,
    baseUrl,
    output: output as OutputMode,
    ...(principal === undefined ? {} : { principal: principal as PrincipalKind }),
    ...(keyScope === undefined ? {} : { keyScope: keyScope as E2eKeyScope }),
    ...(keyStore === undefined ? {} : { keyStore: keyStore as E2eKeyStoreKind }),
    ...(keyDir === undefined ? {} : { keyDir }),
    ...(instanceId === undefined ? {} : { instanceId }),
  }
}

/** A THREA_CONFIG file is the caller binding an identity, so it wins over the ambient environment. */
function pick(explicit: boolean, fromFile: string | undefined, fromEnv: string | undefined): string | undefined {
  return explicit ? (fromFile ?? fromEnv) : (fromEnv ?? fromFile)
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

// The bearer key rides every request to this host — a plaintext or mistyped
// base URL hands the key to whoever answers, so reject anything but HTTPS
// (loopback HTTP allowed for local dev stacks).
function assertSafeBaseUrl(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`[threa] THREA_BASE_URL is not a valid URL: ${baseUrl}`)
  }
  if (url.protocol === "https:") return
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return
  throw new Error(
    `[threa] THREA_BASE_URL must be https:// (http:// is allowed only for localhost) — got ${baseUrl}. ` +
      `The API key is sent as a bearer token to this host on every request.`
  )
}
