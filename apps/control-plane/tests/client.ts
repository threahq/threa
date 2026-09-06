/**
 * HTTP client for control-plane E2E tests with cookie jar support.
 */
import { INTERNAL_API_KEY_HEADER } from "@threahq/backend-common"

function getBaseUrl(): string {
  return process.env.TEST_BASE_URL || "http://localhost:3003"
}

function getInternalApiKey(): string {
  return process.env.TEST_INTERNAL_API_KEY || "test-internal-key"
}

export class TestClient {
  private cookies: Map<string, string> = new Map()

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const headers: Record<string, string> = { ...extraHeaders }

    if (body) {
      headers["Content-Type"] = "application/json"
    }

    if (this.cookies.size > 0) {
      headers["Cookie"] = Array.from(this.cookies.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join("; ")
    }

    const response = await fetch(`${getBaseUrl()}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    })

    // Parse Set-Cookie headers
    const setCookies = response.headers.getSetCookie?.() || []
    for (const cookie of setCookies) {
      const [pair] = cookie.split(";")
      const [name, ...rest] = pair.split("=")
      const value = rest.join("=")
      if (name) {
        const trimmedValue = value.trim()
        if (trimmedValue) {
          this.cookies.set(name.trim(), trimmedValue)
        } else {
          // Empty value means the cookie is being cleared
          this.cookies.delete(name.trim())
        }
      }
    }

    let data: unknown
    const contentType = response.headers.get("content-type")
    if (contentType?.includes("application/json")) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    return { status: response.status, data: data as T, headers: response.headers }
  }

  get<T = unknown>(path: string) {
    return this.request<T>("GET", path)
  }

  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body)
  }

  patch<T = unknown>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, body)
  }

  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path)
  }

  /** Convenience: POST /api/dev/login and return the user */
  internalRequest<T = unknown>(method: string, path: string, body?: unknown) {
    return this.request<T>(method, path, body, { [INTERNAL_API_KEY_HEADER]: getInternalApiKey() })
  }
}

/** Log in via stub auth and return user data */
export async function loginAs(client: TestClient, email: string, name: string): Promise<{ id: string; email: string }> {
  const res = await client.post<{ user: { id: string; email: string } }>("/api/dev/login", { email, name })
  if (res.status !== 200) {
    throw new Error(`Login failed with status ${res.status}: ${JSON.stringify(res.data)}`)
  }
  return res.data.user
}

/** Create a workspace via authenticated API */
export async function createWorkspace(
  client: TestClient,
  name: string,
  region?: string
): Promise<{ id: string; name: string; slug: string; region: string }> {
  const body: Record<string, string> = { name }
  if (region) body.region = region

  const res = await client.post<{ workspace: { id: string; name: string; slug: string; region: string } }>(
    "/api/workspaces",
    body
  )
  if (res.status !== 201) {
    throw new Error(`Create workspace failed with status ${res.status}: ${JSON.stringify(res.data)}`)
  }
  return res.data.workspace
}

/** Create an invitation shadow via internal API */
export async function createShadow(
  client: TestClient,
  params: {
    id: string
    workspaceId: string
    email: string
    region: string
    expiresAt: string
    roleSlug?: string
  }
) {
  const res = await client.internalRequest<{ shadow: unknown }>("POST", "/internal/invitation-shadows", params)
  if (res.status !== 201) {
    throw new Error(`Create shadow failed with status ${res.status}: ${JSON.stringify(res.data)}`)
  }
  return res.data.shadow
}
