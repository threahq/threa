import type { Draft as DraftView } from "@threa/types"
import type { Draft } from "./repository"

/**
 * Wire shape for a draft row. `version` is the optimistic-lock value the client
 * sends back as `expectedVersion` on the next push. The internal-only fields
 * (`lastClientWriteId`, `deletedAt`) never cross the boundary — idempotency and
 * tombstones are server bookkeeping. Drafts are rendered directly from
 * `contentJson` (or decrypted `ciphertext` for E2E), so the row IS the draft.
 */
export function toDraftView(row: Draft): DraftView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    scope: row.scope,
    rootStreamId: row.rootStreamId,
    contentJson: row.contentJson,
    contentMarkdown: row.contentMarkdown,
    attachmentIds: row.attachmentIds,
    command: row.command,
    contextRefs: row.contextRefs,
    ciphertext: row.ciphertext,
    envelope: row.envelope,
    e2eVersion: row.e2eVersion,
    version: row.version,
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
