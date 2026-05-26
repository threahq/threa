import type { KdfParams } from "@/lib/crypto/passphrase"
import { api, ApiError } from "./client"

/**
 * Wire shape for a user's active E2E identity key. All binary fields are
 * base64-encoded on the wire so the JSON body stays valid; the frontend
 * decodes them before passing to the crypto primitives.
 */
export interface E2eKeyResponse {
  keyId: string
  publicKey: string
  encryptedPrivateBundle: string
  kdfSalt: string
  kdfParams: KdfParams
  createdAt: string
}

export interface SetE2eKeyInput {
  publicKey: string
  encryptedPrivateBundle: string
  kdfSalt: string
  kdfParams: KdfParams
}

export interface SetE2eKeyResponse {
  key: E2eKeyResponse
  /** `true` when the call replaced an existing active key (204→201 vs 200). */
  rotated: boolean
}

export const e2eKeysApi = {
  /**
   * Fetch the active key for the calling user. Returns null when the user
   * hasn't set up E2E yet — the backend's 404 isn't an error to surface, it's
   * the "no key yet" signal the setup modal keys off.
   */
  async get(workspaceId: string): Promise<E2eKeyResponse | null> {
    try {
      const res = await api.get<{ key: E2eKeyResponse }>(`/api/workspaces/${workspaceId}/users/me/e2e-key`)
      return res.key
    } catch (err) {
      if (ApiError.isApiError(err) && err.status === 404) return null
      throw err
    }
  },

  async set(workspaceId: string, input: SetE2eKeyInput): Promise<SetE2eKeyResponse> {
    return api.post<SetE2eKeyResponse>(`/api/workspaces/${workspaceId}/users/me/e2e-key`, input)
  },

  async revoke(workspaceId: string): Promise<void> {
    await api.delete(`/api/workspaces/${workspaceId}/users/me/e2e-key`)
  },
}
