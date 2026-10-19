import type { Querier } from "../../../db"

/** Minimal structural shape the sharing service needs of a stream. */
export interface SharingStream {
  id: string
  workspaceId: string
}

export type FindStreamForSharing = (db: Querier, id: string) => Promise<SharingStream | null>

/**
 * Returns true when `userId` has read access to `streamId` in `workspaceId`
 * (direct or inherited via root stream, or the stream is public).
 */
export type CanReadStream = (db: Querier, workspaceId: string, streamId: string, userId: string) => Promise<boolean>
