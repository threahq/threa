import {
  BRIDGE_WORKSPACE_HEADER,
  INTERNAL_API_KEY_HEADER,
  bridgeAttachmentResponseSchema,
  bridgeEventsSchema,
  bridgeManifestSchema,
  bridgeProfilesSchema,
  bridgeSendMessageResponseSchema,
  type BridgeAddReaction,
  type BridgeAttachmentResponse,
  type BridgeEditMessage,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeProfiles,
  type BridgeSendMessage,
  type BridgeSendMessageResponse,
} from "@threahq/types"
import { logger } from "../../lib/logger"
import { hostUnreachable, writeRefused } from "./errors"

// 401 is a bridge key the two regions disagree on, not the host's verdict on the write.
const RETRYABLE_STATUSES = new Set([401, 408, 429])

const REQUEST_TIMEOUT_MS = 5_000

type BridgeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export interface ConnectionAddress {
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

  /** The other end's current name and avatar of the given users, for those it shares. */
  async getProfiles(address: ConnectionAddress, userIds: string[]): Promise<BridgeProfiles> {
    const res = await this.request(address, "/profiles", "POST", { userIds })
    return bridgeProfilesSchema.parse(await res.json())
  }

  /** Tells the other end some of this end's users changed, so it refreshes its copies of them. */
  async pokeProfiles(address: ConnectionAddress): Promise<void> {
    await this.request(address, "/profiles/poke", "POST")
  }

  /** One processed avatar file of a user in another workspace, or null when that workspace has no such file. */
  async getAvatarFile(params: { workspaceId: string; userId: string; file: string }): Promise<Buffer | null> {
    const path = `/api/workspaces/${encodeURIComponent(params.workspaceId)}/users/${encodeURIComponent(params.userId)}/avatar/${encodeURIComponent(params.file)}`
    const res = await fetch(`${this.routerUrl}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Avatar GET ${path} answered ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Sends a partner's message into the host's channel as one of its users. The host dedupes it by client message id. */
  async sendMessage(
    address: ConnectionAddress,
    params: BridgeSendMessage & { streamId: string }
  ): Promise<BridgeSendMessageResponse> {
    const { streamId, ...body } = params
    const res = await this.write(address, messagesPath(streamId), "POST", body)
    return bridgeSendMessageResponseSchema.parse(await res.json())
  }

  async editMessage(
    address: ConnectionAddress,
    params: BridgeEditMessage & { streamId: string; messageId: string }
  ): Promise<void> {
    const { streamId, messageId, ...body } = params
    await this.write(address, messagePath(streamId, messageId), "PATCH", body)
  }

  async deleteMessage(
    address: ConnectionAddress,
    params: { streamId: string; messageId: string; authorId: string }
  ): Promise<void> {
    const query = new URLSearchParams({ authorId: params.authorId })
    await this.write(address, `${messagePath(params.streamId, params.messageId)}?${query}`, "DELETE")
  }

  async addReaction(
    address: ConnectionAddress,
    params: BridgeAddReaction & { streamId: string; messageId: string; emoji: string }
  ): Promise<void> {
    const { streamId, messageId, emoji, ...body } = params
    await this.write(address, reactionPath(streamId, messageId, emoji), "PUT", body)
  }

  async removeReaction(
    address: ConnectionAddress,
    params: { streamId: string; messageId: string; emoji: string; authorId: string }
  ): Promise<void> {
    const query = new URLSearchParams({ authorId: params.authorId })
    await this.write(address, `${reactionPath(params.streamId, params.messageId, params.emoji)}?${query}`, "DELETE")
  }

  private async request(
    address: ConnectionAddress,
    path: string,
    method: "GET" | "POST",
    body?: unknown
  ): Promise<Response> {
    const res = await this.send(address, path, method, body)
    if (!res.ok) throw new Error(`Bridge ${method} ${path.split("?")[0]} answered ${res.status}`)
    return res
  }

  /**
   * A write the host answered with a 4xx is refused for good; one it never
   * answered, answered with a 5xx, or asked to slow down (408, 429) may be retried.
   */
  private async write(
    address: ConnectionAddress,
    path: string,
    method: BridgeMethod,
    body?: unknown
  ): Promise<Response> {
    const where = `${method} ${path.split("?")[0]}`
    let res: Response
    try {
      res = await this.send(address, path, method, body)
    } catch (error) {
      logger.warn({ ...address, where, err: error }, "Bridge write failed")
      throw hostUnreachable(`Bridge ${where} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (res.ok) return res
    const reason = await res
      .json()
      .then((body: { error?: unknown } | null) => (typeof body?.error === "string" ? `: ${body.error}` : ""))
      .catch(() => "")
    const answer = `Bridge ${where} answered ${res.status}${reason}`
    logger.warn({ ...address, where, status: res.status }, answer)
    throw RETRYABLE_STATUSES.has(res.status) || res.status >= 500 ? hostUnreachable(answer) : writeRefused(answer)
  }

  private send(address: ConnectionAddress, path: string, method: BridgeMethod, body?: unknown): Promise<Response> {
    const url = `${this.routerUrl}/api/workspaces/${encodeURIComponent(address.workspaceId)}/stream-connections/${encodeURIComponent(address.connectionId)}/bridge${path}`
    return fetch(url, {
      method,
      headers: {
        [INTERNAL_API_KEY_HEADER]: this.apiKey,
        [BRIDGE_WORKSPACE_HEADER]: address.callerWorkspaceId,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }
}

function messagesPath(streamId: string): string {
  return `/streams/${encodeURIComponent(streamId)}/messages`
}

function messagePath(streamId: string, messageId: string): string {
  return `${messagesPath(streamId)}/${encodeURIComponent(messageId)}`
}

function reactionPath(streamId: string, messageId: string, emoji: string): string {
  return `${messagePath(streamId, messageId)}/reactions/${encodeURIComponent(emoji)}`
}
