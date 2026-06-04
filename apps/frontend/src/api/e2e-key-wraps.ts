import type { E2eKeyWrapsResponse, E2eOwnerKeyWrapInput, E2eKeyRollInput, E2eActorRewrapInput } from "@threa/types"
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

  /**
   * Roll the stream's SSK forward one generation: a fresh SSK wrapped to the
   * owner plus every actor recipient. The server stores the batch and bumps
   * `current_key_generation` to `input.keyGeneration` atomically, so a new
   * send never seals under a generation that has no wraps.
   */
  async roll(workspaceId: string, streamId: string, input: E2eKeyRollInput): Promise<void> {
    await api.post<void>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/key-generations`, input)
  },

  /**
   * Re-wrap the *current* SSK to invited actors' live keys that lost their
   * wrap (an enclave restart mints a fresh EIK). No generation bump — the
   * actor already held this generation, so the new instance gets exactly the
   * prior access, and a turn parked on the missing wrap revives.
   */
  async reviveActorWraps(workspaceId: string, streamId: string, input: E2eActorRewrapInput): Promise<void> {
    await api.post<void>(`/api/workspaces/${workspaceId}/streams/${streamId}/e2e/actor-key-wraps`, input)
  },
}
