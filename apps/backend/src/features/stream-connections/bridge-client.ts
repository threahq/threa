import { BRIDGE_WORKSPACE_HEADER, INTERNAL_API_KEY_HEADER } from "@threahq/types"

const POKE_TIMEOUT_MS = 5_000

/** This region's calls to another workspace's bridge, routed to that workspace's region by the workspace router. */
export class BridgeClient {
  private readonly routerUrl: string
  private readonly apiKey: string

  constructor({ routerUrl, apiKey }: { routerUrl: string; apiKey: string }) {
    this.routerUrl = routerUrl.replace(/\/+$/, "")
    this.apiKey = apiKey
  }

  /** Tells a partner its shared channel changed, so it pulls. Carries nothing about the change. */
  async poke(params: { partnerWorkspaceId: string; connectionId: string; hostWorkspaceId: string }): Promise<void> {
    const url = `${this.routerUrl}/api/workspaces/${encodeURIComponent(params.partnerWorkspaceId)}/stream-connections/${encodeURIComponent(params.connectionId)}/bridge/poke`
    const res = await fetch(url, {
      method: "POST",
      headers: { [INTERNAL_API_KEY_HEADER]: this.apiKey, [BRIDGE_WORKSPACE_HEADER]: params.hostWorkspaceId },
      signal: AbortSignal.timeout(POKE_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Bridge poke answered ${res.status}`)
  }
}
