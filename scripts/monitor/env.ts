import { homedir } from "node:os"
import { join } from "node:path"
import { AGENT_ENV_FILE, CREDENTIAL_KEYS, type CredentialKey } from "./config"

export type Credentials = Partial<Record<CredentialKey, string>>

export interface LoadedEnv {
  creds: Credentials
  /** Keys that came from the agents env file rather than the process env. */
  fromFile: CredentialKey[]
  missing: CredentialKey[]
}

/** Parses `KEY=value` lines (optional `export `, optional single/double quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

export function resolveCredentials(processEnv: Record<string, string | undefined>, fileText: string | null): LoadedEnv {
  const fileVars = fileText ? parseEnvFile(fileText) : {}
  const creds: Credentials = {}
  const fromFile: CredentialKey[] = []
  const missing: CredentialKey[] = []
  for (const key of CREDENTIAL_KEYS) {
    const fromProcess = processEnv[key]
    if (fromProcess) {
      creds[key] = fromProcess
    } else if (fileVars[key]) {
      creds[key] = fileVars[key]
      fromFile.push(key)
    } else {
      missing.push(key)
    }
  }
  return { creds, fromFile, missing }
}

export async function loadCredentials(): Promise<LoadedEnv> {
  const file = Bun.file(join(homedir(), AGENT_ENV_FILE.replace(/^~\//, "")))
  const text = (await file.exists()) ? await file.text() : null
  return resolveCredentials(process.env, text)
}
