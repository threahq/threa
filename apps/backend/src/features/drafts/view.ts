import type { Draft as DraftView } from "@threahq/types"
import type { Draft } from "./repository"

/**
 * Wire shape for a draft row. `version` is the optimistic-lock value the client
 * sends back as `expectedVersion` on the next push. Tombstones remain server
 * bookkeeping; `lastClientWriteId` crosses the boundary only so a device that
 * just sent the draft can suppress/delete its own lost-ack echoes without
 * mistaking them for another device's drift. Drafts are rendered directly from
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
    stashedAt: row.stashedAt ? row.stashedAt.toISOString() : null,
    lastClientWriteId: row.lastClientWriteId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
