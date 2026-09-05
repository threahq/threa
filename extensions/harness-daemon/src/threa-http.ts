export interface ThreaTarget {
  baseUrl: string
  workspaceId: string
  apiKey: string
}

/** Every harnessd write to Threa goes through here, so auth, timeout and URL shape are stated once. */
export function postThrea(target: ThreaTarget, path: string, body: unknown): Promise<Response> {
  return fetch(`${target.baseUrl}/api/v1/workspaces/${target.workspaceId}${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${target.apiKey}` },
    body: JSON.stringify(body),
  })
}

export async function failureExcerpt(response: Response): Promise<string> {
  const text = await response.text().catch(() => "")
  return `${response.status} ${text.slice(0, 300)}`
}
