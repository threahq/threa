import type { ApiKeyService, ValidatedApiKey } from "./api-key-service"

/**
 * Stub API key service for testing.
 *
 * Keys can be registered explicitly via addKey(), or the stub auto-accepts
 * keys matching the format `test__<orgId>__<permissions>` (double-underscore delimited)
 * where permissions is a comma-separated list.
 *
 * Example: `test__org_123__messages:search,streams:list`
 */
export class StubApiKeyService implements ApiKeyService {
  private keys = new Map<string, ValidatedApiKey>()

  addKey(value: string, key: ValidatedApiKey): void {
    this.keys.set(value, key)
  }

  async validateApiKey(value: string): Promise<ValidatedApiKey | null> {
    const explicit = this.keys.get(value)
    if (explicit) return explicit

    const parts = value.split("__")
    if (parts.length === 3 && parts[0] === "test") {
      return {
        id: `apikey_stub_${parts[1]}_${parts[2].replace(/[^a-z0-9]/g, "_")}`,
        name: "Test API Key",
        organizationId: parts[1],
        permissions: new Set(parts[2].split(",")),
      }
    }

    return null
  }
}
