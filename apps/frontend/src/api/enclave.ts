import type { StreamWithPreview } from "@threa/types"
import { api } from "./client"

/**
 * One row from the live enclave-instance set. The list scales with the number
 * of enclave instances heartbeating into the backend; the recipients popover
 * surfaces one fingerprint per entry plus the owner's UIK.
 */
export interface ActiveEnclaveKey {
  instanceId: string
  keyId: string
  /** Base64-encoded raw X25519 public key — feed straight to HPKE recipient import. */
  publicKey: string
}

export const enclaveApi = {
  /**
   * Live EIK set across the fleet. The composer fetches this on every send
   * into an enclave-invited E2E stream so the per-message recipient list
   * mirrors whichever instances are heartbeating right now — no pinned key
   * on the stream itself.
   */
  async getActiveKeys(workspaceId: string): Promise<ActiveEnclaveKey[]> {
    const res = await api.get<{ keys: ActiveEnclaveKey[] }>(`/api/workspaces/${workspaceId}/enclave/active-keys`)
    return res.keys
  },

  /**
   * Owner-only opt-in: marks the stream as having the enclave fleet as a
   * second recipient on subsequent messages. The stream stores no pinned
   * `keyId` — recipients are recomputed per-message from `getActiveKeys`.
   */
  async invite(workspaceId: string, streamId: string): Promise<StreamWithPreview> {
    const res = await api.post<{ stream: StreamWithPreview }>(
      `/api/workspaces/${workspaceId}/streams/${streamId}/invite-enclave`,
      {}
    )
    return res.stream
  },
}
