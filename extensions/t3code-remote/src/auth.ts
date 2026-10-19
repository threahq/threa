import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { promisify } from "node:util"
import { writeFileAtomic } from "@threahq/remote-session"
import { parseAccess, readJsonFile, str, type T3Access } from "./config"

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** The token is missing, expired or rejected, and only a fresh login fixes it. */
export class T3AuthError extends Error {}

// T3 accepts any loopback redirect for a public client; the code is read from the redirect, never served.
const REDIRECT_URI = "http://127.0.0.1:45999/callback"
const PAIRING_LABEL = "Threa connector"
const LOGIN_HINT = "Run `threa-t3code login` on the T3 Code host, or set t3AutoLogin."

async function postJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`T3 Code ${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 300)}`)
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/**
 * T3's headless MCP OAuth: register a public client, consent with a pairing
 * code instead of a browser, then exchange the code (PKCE) for a bearer token.
 */
async function exchangePairingCode(params: {
  url: string
  code: string
  access: T3Access
  fetch?: FetchLike
}): Promise<string> {
  const fetchImpl = params.fetch ?? fetch
  const resource = `${params.url}/mcp`
  const verifier = randomBytes(32).toString("base64url")
  const client = await postJson(fetchImpl, `${params.url}/oauth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: PAIRING_LABEL,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  })
  const clientId = String(client.client_id ?? "")
  const decision = await postJson(fetchImpl, `${params.url}/oauth/mcp/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: randomBytes(8).toString("base64url"),
        resource,
      },
      decision: { _tag: "pairing-code", access: params.access, code: params.code },
    }),
  })
  const code = new URL(String(decision.redirectTo ?? ""), params.url).searchParams.get("code")
  if (!code) throw new Error("T3 Code refused the pairing code (no authorization code in its redirect).")
  const token = await postJson(fetchImpl, `${params.url}/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  })
  if (typeof token.access_token !== "string") throw new Error("T3 Code issued no access token.")
  return token.access_token
}

/** A one-time pairing code from the `t3` CLI, which reads the server's state dir (`T3CODE_HOME`) directly. */
async function mintPairingCode(): Promise<string> {
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)("t3", ["auth", "pairing", "create", "--label", PAIRING_LABEL, "--json"], {
      timeout: 60_000,
    }))
  } catch (error) {
    throw new Error(
      `Could not mint a T3 Code pairing code with \`t3 auth pairing create\`: ${error instanceof Error ? error.message : String(error)}. ` +
        "Put the t3 CLI on PATH (with T3CODE_HOME if the server uses another state dir), or pass a code to `threa-t3code login <code>`."
    )
  }
  const credential = (JSON.parse(stdout) as { credential?: unknown }).credential
  if (typeof credential !== "string" || credential.length === 0) {
    throw new Error("`t3 auth pairing create` printed no credential.")
  }
  return credential
}

export interface T3Token {
  accessToken: string
  access: T3Access
  /** The server the token was minted by; a token for another server is not reused. */
  url: string
}

export function readToken(path: string): T3Token | undefined {
  const parsed = readJsonFile(path)
  if (!parsed) return undefined
  const accessToken = str(parsed.accessToken)
  const access = parseAccess(parsed.access)
  const url = str(parsed.url)
  return accessToken && access && url ? { accessToken, access, url } : undefined
}

export function writeToken(path: string, token: T3Token): void {
  writeFileAtomic(path, `${JSON.stringify(token, null, 2)}\n`)
}

export interface T3AuthOptions {
  url: string
  access: T3Access
  tokenPath: string
  autoLogin: boolean
  fetch?: FetchLike
  mintCode?: () => Promise<string>
}

/** The MCP bearer token: the saved one, or with `autoLogin` a freshly minted one whenever it is missing or rejected. */
export class T3Auth {
  private cached?: string
  private renewing?: Promise<string>

  constructor(private readonly options: T3AuthOptions) {}

  async token(): Promise<string> {
    if (this.cached) return this.cached
    const saved = readToken(this.options.tokenPath)
    if (saved && saved.url === this.options.url && saved.access === this.options.access)
      return (this.cached = saved.accessToken)
    if (!this.options.autoLogin) throw new T3AuthError(`Not logged in to T3 Code at ${this.options.url}. ${LOGIN_HINT}`)
    return this.renew(undefined)
  }

  /** Called after T3 rejects `rejected`; a caller whose token was already replaced gets the replacement, not another login. */
  renew(rejected: string | undefined): Promise<string> {
    if (this.renewing) return this.renewing
    if (this.cached && this.cached !== rejected) return Promise.resolve(this.cached)
    if (!this.options.autoLogin) {
      this.cached = undefined
      return Promise.reject(new T3AuthError(`T3 Code rejected the saved token (it lasts 30 days). ${LOGIN_HINT}`))
    }
    this.renewing = this.login().finally(() => (this.renewing = undefined))
    return this.renewing
  }

  /** Exchange a pairing code (minted locally when none is given) and save the token. */
  async login(code?: string): Promise<string> {
    const { url, access, tokenPath } = this.options
    const pairingCode = code ?? (await (this.options.mintCode ?? mintPairingCode)())
    const accessToken = await exchangePairingCode({
      url,
      code: pairingCode,
      access,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    })
    writeToken(tokenPath, { accessToken, access, url })
    return (this.cached = accessToken)
  }
}
