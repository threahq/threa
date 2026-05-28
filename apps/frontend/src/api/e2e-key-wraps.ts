import type { E2eKeyWrapsResponse, E2eOwnerKeyWrapInput } from "@threa/types"
import { api } from "./client"

/**
 * Client for a stream's per-stream-key (SSK) wraps. The server stores one
 * HPKE-wrapped copy of each key generation per authorized recipient; this
 * returns the full set plus the stream's current generation. The wrap
 * ciphertext is safe to hand to any member — only the holder of the matching
 * private key (UIK/EIK) can unwrap it.
 */
export const e2eKeyWrapsApi = {
  async get(workspaceId: string, streamId: string): Promise<E2eKeyWrapsResponse> {
    return api.get<E2eKeyWrapsResponse>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/key-wraps`)
  },

  /**
   * Store the owner's generation-0 SSK wrap after the stream exists (its AAD
   * binds to the server-minted stream id). The server derives the recipient
   * slot from the stream's owner key — only the opaque wrap bytes are sent.
   */
  async store(workspaceId: string, streamId: string, wrap: E2eOwnerKeyWrapInput): Promise<void> {
    await api.post<void>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/key-wraps`, wrap)
  },
}
