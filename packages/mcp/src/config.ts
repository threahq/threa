import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ThreaMcpConfig {
  apiKey: string
  workspaceId: string
  baseUrl: string
}

const DEFAULT_BASE_URL = "https://app.threa.io"

interface FileConfig {
  apiKey?: string
  workspaceId?: string
  baseUrl?: string
}

function readFileConfig(): FileConfig {
  const explicit = process.env.THREA_MCP_CONFIG
  const path = explicit ?? join(homedir(), ".threa", "mcp.json")
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    if (explicit) {
      throw new Error(`[threa-mcp] THREA_MCP_CONFIG points to ${path}, but it could not be read.`)
    }
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`[threa-mcp] Config file ${path} is not valid JSON.`)
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`[threa-mcp] Config file ${path} must contain a JSON object with { apiKey, workspaceId, baseUrl }.`)
  }
  return parsed as FileConfig
}

export function loadConfig(): ThreaMcpConfig {
  const file = readFileConfig()

  const apiKey = process.env.THREA_API_KEY ?? file.apiKey
  const workspaceId = process.env.THREA_WORKSPACE_ID ?? file.workspaceId
  const baseUrl = process.env.THREA_BASE_URL ?? file.baseUrl ?? DEFAULT_BASE_URL

  const missing: string[] = []
  if (!apiKey) missing.push("THREA_API_KEY")
  if (!workspaceId) missing.push("THREA_WORKSPACE_ID")
  if (missing.length > 0) {
    throw new Error(
      `[threa-mcp] Missing required config: ${missing.join(", ")}. ` +
        `Set them as environment variables, or provide a JSON file at ~/.threa/mcp.json ` +
        `(or the path in THREA_MCP_CONFIG) with { apiKey, workspaceId, baseUrl }. Environment variables win over the file.`
    )
  }

  return { apiKey: apiKey!, workspaceId: workspaceId!, baseUrl }
}
