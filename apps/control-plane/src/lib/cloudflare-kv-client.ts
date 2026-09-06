import { logger } from "@threahq/backend-common"
import type { CloudflareKvConfig } from "../config"

export interface KvClient {
  putWorkspaceRegion(workspaceId: string, region: string): Promise<void>
}

export class CloudflareKvClient implements KvClient {
  constructor(private config: CloudflareKvConfig) {}

  async putWorkspaceRegion(workspaceId: string, region: string): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/storage/kv/namespaces/${this.config.namespaceId}/values/${workspaceId}`

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        "Content-Type": "text/plain",
      },
      body: region,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error({ workspaceId, region, status: res.status, body }, "Cloudflare KV write failed")
      throw new Error(`Cloudflare KV returned ${res.status}: ${body}`)
    }

    logger.info({ workspaceId, region }, "Wrote workspace-to-region mapping to Cloudflare KV")
  }
}

export class NoopKvClient implements KvClient {
  async putWorkspaceRegion(workspaceId: string, region: string): Promise<void> {
    logger.debug({ workspaceId, region }, "NoopKvClient: skipping KV write (no Cloudflare KV configured)")
  }
}
