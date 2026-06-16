/**
 * Linear OAuth 2.0 helpers.
 *
 * `authorization_code` with `actor=app`: a workspace admin authorizes once and
 * the tokens represent the app across all public teams. 24 h tokens with refresh.
 *
 * Docs: https://linear.app/developers/oauth-2-0-authentication
 */

const AUTHORIZE_URL = "https://linear.app/oauth/authorize"
const TOKEN_URL = "https://api.linear.app/oauth/token"
const REVOKE_URL = "https://api.linear.app/oauth/revoke"

/**
 * `app:assignable` / `app:mentionable` are requested up front to avoid a
 * re-consent flow when agent surfaces ship. `admin` is omitted because it
 * conflicts with `actor=app`.
 */
export const LINEAR_OAUTH_SCOPES = ["read", "app:assignable", "app:mentionable"] as const
export const LINEAR_OAUTH_SCOPE_STRING = LINEAR_OAUTH_SCOPES.join(",")

export interface LinearOAuthTokenResponse {
  accessToken: string
  refreshToken: string | null
  tokenType: string
  expiresIn: number
  scope: string
}

export interface BuildAuthorizationUrlParams {
  clientId: string
  redirectUri: string
  state: string
}

export function buildLinearAuthorizationUrl(params: BuildAuthorizationUrlParams): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("client_id", params.clientId)
  url.searchParams.set("redirect_uri", params.redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", LINEAR_OAUTH_SCOPE_STRING)
  url.searchParams.set("state", params.state)
  url.searchParams.set("actor", "app")
  url.searchParams.set("prompt", "consent")
  return url.toString()
}

export interface ExchangeCodeParams {
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  fetchImpl?: typeof fetch
}

export async function exchangeLinearCode(params: ExchangeCodeParams): Promise<LinearOAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  })
  return postOAuthToken(TOKEN_URL, body, params.fetchImpl)
}

export interface RefreshTokenParams {
  clientId: string
  clientSecret: string
  refreshToken: string
  fetchImpl?: typeof fetch
}

export async function refreshLinearToken(params: RefreshTokenParams): Promise<LinearOAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  })
  return postOAuthToken(TOKEN_URL, body, params.fetchImpl)
}

export interface RevokeTokenParams {
  accessToken: string
  fetchImpl?: typeof fetch
}

export async function revokeLinearToken(params: RevokeTokenParams): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch
  const body = new URLSearchParams({ token: params.accessToken, token_type_hint: "access_token" })
  const response = await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })
  // Linear returns 400 for "already revoked" which is fine for our disconnect flow.
  if (response.status !== 200 && response.status !== 400) {
    const text = await response.text().catch(() => "")
    throw new Error(`Linear token revocation failed with status ${response.status}: ${text}`)
  }
}

async function postOAuthToken(
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch = fetch
): Promise<LinearOAuthTokenResponse> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`Linear OAuth request failed with status ${response.status}: ${text}`)
  }

  const json = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    token_type?: unknown
    expires_in?: unknown
    scope?: unknown
  }

  if (typeof json.access_token !== "string") {
    throw new Error("Linear OAuth response missing access_token")
  }
  if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) {
    throw new Error("Linear OAuth response missing expires_in")
  }

  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    tokenType: typeof json.token_type === "string" ? json.token_type : "Bearer",
    expiresIn: json.expires_in,
    scope: typeof json.scope === "string" ? json.scope : "",
  }
}

export function expiresAtFromNow(expiresInSeconds: number, nowMs = Date.now()): string {
  return new Date(nowMs + expiresInSeconds * 1000).toISOString()
}
