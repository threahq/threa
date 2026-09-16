import type { ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"

/** No declaration means no assertion: human use of a personal key is unchanged. */
export async function assertPrincipal(client: ThreaApiClient, config: ThreaConfig): Promise<void> {
  if (config.principal === undefined) return
  const { data } = await client.get<{ data: { kind: string; userId?: string; botId?: string } }>("/me")
  if (data.kind === config.principal) return
  throw new Error(
    `threa: config declares principal "${config.principal}" but the key belongs to ${data.kind} ${
      data.userId ?? data.botId ?? "?"
    } (INV-11)`
  )
}
