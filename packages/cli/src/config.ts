import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const OUTPUT_MODES = ["text", "json"] as const
export type OutputMode = (typeof OUTPUT_MODES)[number]

export interface ThreaConfig {
  apiKey: string
  workspaceId: string
  baseUrl: string
  output: OutputMode
}

const DEFAULT_BASE_URL = "https://app.threa.io"

interface FileConfig {
  apiKey?: string
  workspaceId?: string
  baseUrl?: string
  output?: string
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

  const apiKey = process.env.THREA_API_KEY ?? file.apiKey
  const workspaceId = process.env.THREA_WORKSPACE_ID ?? file.workspaceId
  const baseUrl = process.env.THREA_BASE_URL ?? file.baseUrl ?? DEFAULT_BASE_URL
  const output = file.output ?? "text"

  const missing: string[] = []
  if (!apiKey) missing.push("THREA_API_KEY")
  if (!workspaceId) missing.push("THREA_WORKSPACE_ID")
  if (missing.length > 0) {
    throw new Error(
      `[threa] Missing required config: ${missing.join(", ")}. ` +
        `Set them as environment variables, or provide a JSON file at ~/.threa/config.json ` +
        `(or the path in THREA_CONFIG) with { apiKey, workspaceId, baseUrl }. Environment variables win over the file.`
    )
  }

  if (!(OUTPUT_MODES as readonly string[]).includes(output)) {
    throw new Error(`[threa] Config "output" must be one of ${OUTPUT_MODES.join(", ")} — got "${output}".`)
  }

  assertSafeBaseUrl(baseUrl)

  return { apiKey: apiKey!, workspaceId: workspaceId!, baseUrl, output: output as OutputMode }
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
