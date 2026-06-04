import type { Pool } from "pg"
import type { AttachmentService } from "../../attachments"
import type { MemoExplorerService } from "../../memos"
import type { SearchService } from "../../search"
import type { StorageProvider } from "../../../lib/storage/s3-client"

export interface WorkspaceToolDeps {
  db: Pool
  workspaceId: string
  accessibleStreamIds: string[]
  invokingUserId: string
  searchService: SearchService
  storage: StorageProvider
  attachmentService: AttachmentService
  memoExplorer: MemoExplorerService
}

/**
 * Reaction callbacks for the `react_to_message` tool. Separate from
 * `WorkspaceToolDeps` because only this one tool needs them — the persona
 * identity and `actorType: "persona"` are bound by the caller, so the tool only
 * supplies the target message, its stream, and the emoji shortcode. Each
 * resolves to the updated message, or `null` when the message no longer exists.
 */
export interface ReactionToolDeps {
  addReaction: (params: { streamId: string; messageId: string; emoji: string }) => Promise<{ id: string } | null>
  removeReaction: (params: { streamId: string; messageId: string; emoji: string }) => Promise<{ id: string } | null>
}
