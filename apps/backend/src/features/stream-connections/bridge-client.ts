import {
  BRIDGE_WORKSPACE_HEADER,
  INTERNAL_API_KEY_HEADER,
  bridgeAttachmentResponseSchema,
  bridgeEventsSchema,
  bridgeManifestSchema,
  type BridgeAttachmentResponse,
  type BridgeEvents,
  type BridgeManifest,
} from "@threahq/types"

const REQUEST_TIMEOUT_MS = 5_000

interface ConnectionAddress {
  /** The workspace whose bridge is called. */
  workspaceId: string
  connectionId: string
  /** The workspace calling, which the bridge checks against the connection's other end. */
  callerWorkspaceId: string
}

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
    await this.request(
      {
        workspaceId: params.partnerWorkspaceId,
        connectionId: params.connectionId,
        callerWorkspaceId: params.hostWorkspaceId,
      },
      "/poke",
      "POST"
    )
  }

  /** The host's shared tree: every stream a partner copies, with its current name and head. */
  async getManifest(address: ConnectionAddress): Promise<BridgeManifest> {
    const res = await this.request(address, "/manifest", "GET")
    return bridgeManifestSchema.parse(await res.json())
  }

  /** A page of one host stream's changes after a cursor. */
  async listEvents(
    address: ConnectionAddress,
    params: { streamId: string; after: bigint; limit: number }
  ): Promise<BridgeEvents> {
    const query = new URLSearchParams({ after: params.after.toString(), limit: String(params.limit) })
    const res = await this.request(address, `/streams/${encodeURIComponent(params.streamId)}/events?${query}`, "GET")
    return bridgeEventsSchema.parse(await res.json())
  }

  /** Whether a host attachment's bytes can be fetched yet, and from where. */
  async getAttachment(address: ConnectionAddress, attachmentId: string): Promise<BridgeAttachmentResponse> {
    const res = await this.request(address, `/attachments/${encodeURIComponent(attachmentId)}`, "GET")
    return bridgeAttachmentResponseSchema.parse(await res.json())
  }

  private async request(address: ConnectionAddress, path: string, method: "GET" | "POST"): Promise<Response> {
    const url = `${this.routerUrl}/api/workspaces/${encodeURIComponent(address.workspaceId)}/stream-connections/${encodeURIComponent(address.connectionId)}/bridge${path}`
    const res = await fetch(url, {
      method,
      headers: { [INTERNAL_API_KEY_HEADER]: this.apiKey, [BRIDGE_WORKSPACE_HEADER]: address.callerWorkspaceId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Bridge ${method} ${path.split("?")[0]} answered ${res.status}`)
    return res
  }
}
