import { WorkOS } from "@workos-inc/node"
import { logger } from "../logger"
import { WORKOS_REQUEST_TIMEOUT_MS, type WorkosConfig } from "./types"

export interface ValidatedApiKey {
  id: string
  name: string
  organizationId: string
  permissions: Set<string>
}

export interface ApiKeyService {
  validateApiKey(value: string): Promise<ValidatedApiKey | null>
}

export class WorkosApiKeyService implements ApiKeyService {
  private workos: WorkOS

  constructor(config: WorkosConfig) {
    this.workos = new WorkOS(config.apiKey, { clientId: config.clientId, timeout: WORKOS_REQUEST_TIMEOUT_MS })
  }

  async validateApiKey(value: string): Promise<ValidatedApiKey | null> {
    try {
      const { apiKey } = await this.workos.apiKeys.validateApiKey({ value })
      if (!apiKey) return null

      return {
        id: apiKey.id,
        name: apiKey.name,
        organizationId: apiKey.owner.id,
        permissions: new Set(apiKey.permissions),
      }
    } catch (error: unknown) {
      // WorkOS SDK throws structured exceptions with a `status` property for HTTP errors.
      // Client errors (400, 401, 404, 422) mean the key is invalid/revoked → return null.
      // Server errors (5xx) or network failures (no status) → re-throw for 500.
      const status = (error as { status?: number }).status
      if (status && status >= 400 && status < 500) {
        logger.debug({ error, status }, "API key validation rejected")
        return null
      }
      logger.warn({ error }, "API key validation infrastructure error")
      throw error
    }
  }
}
