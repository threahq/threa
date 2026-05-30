import { Pool } from "pg"
import { withTransaction } from "../../db"
import { SidebarConfigRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import { type SidebarConfig, type RawSidebarConfig, DEFAULT_SIDEBAR_CONFIG, normalizeSidebarConfig } from "@threa/types"

export class SidebarConfigService {
  constructor(private pool: Pool) {}

  /**
   * Get a user's sidebar config, falling back to the code-defined default
   * when they have never customized it.
   */
  async getConfig(workspaceId: string, userId: string): Promise<SidebarConfig> {
    // Single query, INV-30. Normalize so documents persisted before quick links
    // were configurable come back with the full, ordered quick-link list.
    const stored = await SidebarConfigRepository.find(this.pool, workspaceId, userId)
    return normalizeSidebarConfig(stored ?? DEFAULT_SIDEBAR_CONFIG)
  }

  /**
   * Replace a user's sidebar config and broadcast to their other devices via
   * the outbox (author-scoped event).
   */
  async updateConfig(workspaceId: string, userId: string, config: RawSidebarConfig): Promise<SidebarConfig> {
    const normalized = normalizeSidebarConfig(config)
    return withTransaction(this.pool, async (client) => {
      await SidebarConfigRepository.upsert(client, workspaceId, userId, normalized)

      await OutboxRepository.insert(client, "sidebar_config:updated", {
        workspaceId,
        authorId: userId,
        sidebarConfig: normalized,
      })

      return normalized
    })
  }
}
