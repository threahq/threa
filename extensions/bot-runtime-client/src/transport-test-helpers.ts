import type { BotRuntimeHello, BotRuntimeTransportOptions } from "./types"

export const TEST_TRANSPORT_REQUEST_CONFIG = {
  baseUrl: "https://app.example.test",
  workspaceId: "ws_1",
  apiKey: "threa_bk_test",
} as const

export function testTransportOptions(
  hello: BotRuntimeHello,
  overrides: Partial<BotRuntimeTransportOptions> = {}
): BotRuntimeTransportOptions {
  return { ...TEST_TRANSPORT_REQUEST_CONFIG, hello, ...overrides }
}
