import { api } from "./client"
import type { AuthorType } from "@threahq/types"

/**
 * A stream brief (roadmap 4.1) as it arrives on the wire — `Date` columns are
 * ISO strings after JSON serialization. Threads carry no brief of their own;
 * GET/PUT on a thread resolve the root's brief server-side.
 */
export interface StreamBrief {
  id: string
  workspaceId: string
  streamId: string
  content: string
  version: number
  updatedByKind: AuthorType
  updatedById: string
  createdAt: string
  updatedAt: string
}

export const streamBriefsApi = {
  async get(workspaceId: string, streamId: string): Promise<StreamBrief | null> {
    const { brief } = await api.get<{ brief: StreamBrief | null }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/brief`
    )
    return brief
  },

  /**
   * Full-replacement write with optimistic concurrency. `version` is what the
   * client last read (0 when no brief existed). A concurrent write throws an
   * `ApiError` with code `BRIEF_VERSION_CONFLICT` carrying `details.current`.
   */
  async put(workspaceId: string, streamId: string, input: { content: string; version: number }): Promise<StreamBrief> {
    const { brief } = await api.put<{ brief: StreamBrief }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/brief`,
      input
    )
    return brief
  },
}
