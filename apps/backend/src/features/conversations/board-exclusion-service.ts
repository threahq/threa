import { Pool } from "pg"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { BoardExclusionRepository, type HiddenConversation } from "./board-exclusion-repository"

export interface BoardExclusions {
  hiddenConversations: { conversationId: string; hiddenAt: string }[]
  mutedStreamIds: string[]
}

/**
 * Per-viewer board exclusions: hide/unhide
 * a conversation card, mute/unmute a stream from the board. Each mutation writes
 * its row and emits a user-scoped outbox event in the same transaction (INV-7) so
 * the viewer's other devices reconcile; there is no stream delivery (these are
 * private board state, not shared events).
 */
export class BoardExclusionService {
  constructor(private pool: Pool) {}

  async hideConversation(params: {
    workspaceId: string
    conversationId: string
    userId: string
  }): Promise<{ hiddenAt: string }> {
    const { workspaceId, conversationId, userId } = params
    return withTransaction(this.pool, async (client) => {
      const { hiddenAt } = await BoardExclusionRepository.hideConversation(client, {
        workspaceId,
        conversationId,
        userId,
      })
      await OutboxRepository.insert(client, "board:conversation_hide_changed", {
        targetUserId: userId,
        workspaceId,
        conversationId,
        active: true,
        hiddenAt: hiddenAt.toISOString(),
      })
      return { hiddenAt: hiddenAt.toISOString() }
    })
  }

  async unhideConversation(params: { workspaceId: string; conversationId: string; userId: string }): Promise<void> {
    const { workspaceId, conversationId, userId } = params
    await withTransaction(this.pool, async (client) => {
      await BoardExclusionRepository.unhideConversation(client, workspaceId, conversationId, userId)
      await OutboxRepository.insert(client, "board:conversation_hide_changed", {
        targetUserId: userId,
        workspaceId,
        conversationId,
        active: false,
      })
    })
  }

  async muteStream(params: { workspaceId: string; streamId: string; userId: string }): Promise<void> {
    const { workspaceId, streamId, userId } = params
    await withTransaction(this.pool, async (client) => {
      await BoardExclusionRepository.muteStream(client, { workspaceId, streamId, userId })
      await OutboxRepository.insert(client, "board:stream_mute_changed", {
        targetUserId: userId,
        workspaceId,
        streamId,
        active: true,
      })
    })
  }

  async unmuteStream(params: { workspaceId: string; streamId: string; userId: string }): Promise<void> {
    const { workspaceId, streamId, userId } = params
    await withTransaction(this.pool, async (client) => {
      await BoardExclusionRepository.unmuteStream(client, workspaceId, streamId, userId)
      await OutboxRepository.insert(client, "board:stream_mute_changed", {
        targetUserId: userId,
        workspaceId,
        streamId,
        active: false,
      })
    })
  }

  /** The viewer's full exclusion set — the board bootstrap read. Single queries, INV-30. */
  async getExclusions(workspaceId: string, userId: string): Promise<BoardExclusions> {
    const [hidden, mutedStreamIds] = await Promise.all([
      BoardExclusionRepository.listHiddenConversations(this.pool, workspaceId, userId),
      BoardExclusionRepository.listMutedStreamIds(this.pool, workspaceId, userId),
    ])
    return {
      hiddenConversations: hidden.map((row: HiddenConversation) => ({
        conversationId: row.conversationId,
        hiddenAt: row.hiddenAt.toISOString(),
      })),
      mutedStreamIds,
    }
  }
}
