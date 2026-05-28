import { enclaveRuntimeId } from "../../lib/id"
import type { Pool } from "pg"
import { EnclaveRuntimesRepository, type EnclaveRuntime, type RegisterEnclaveKeyParams } from "./repository"

/**
 * Staleness window for the "live" enclave set. A row counts as live when
 * `revoked_at IS NULL AND last_seen_at > NOW() - 2 minutes`. Each instance's
 * heartbeat fires every ~30s; two minutes gives four heartbeats of grace
 * before a stalled instance falls out of the live set.
 */
export const ENCLAVE_RUNTIME_STALENESS_MS = 2 * 60 * 1000

export interface RegisterEnclaveKeyInput {
  instanceId: string
  keyId: string
  publicKey: Uint8Array
  instanceUrl: string
}

export class EnclaveRuntimesService {
  constructor(private readonly pool: Pool) {}

  async registerKey(input: RegisterEnclaveKeyInput): Promise<EnclaveRuntime> {
    const params: RegisterEnclaveKeyParams = {
      id: enclaveRuntimeId(),
      instanceId: input.instanceId,
      keyId: input.keyId,
      publicKey: input.publicKey,
      instanceUrl: input.instanceUrl,
    }
    return EnclaveRuntimesRepository.registerKey(this.pool, params)
  }

  async heartbeat(keyId: string): Promise<boolean> {
    return EnclaveRuntimesRepository.heartbeat(this.pool, keyId)
  }

  /**
   * Live EIK list. Used by the dispatcher to pick an instance to invoke and by
   * the frontend (via `/enclave/active-keys`) to wrap the SSK to each live EIK.
   */
  async listLive(): Promise<EnclaveRuntime[]> {
    return EnclaveRuntimesRepository.listLive(this.pool, ENCLAVE_RUNTIME_STALENESS_MS)
  }

  async revoke(keyId: string): Promise<void> {
    return EnclaveRuntimesRepository.revoke(this.pool, keyId)
  }
}
