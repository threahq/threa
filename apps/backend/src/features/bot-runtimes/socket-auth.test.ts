import { describe, expect, it, mock } from "bun:test"
import type { Socket } from "socket.io"
import { WORKSPACE_PERMISSION_SCOPES } from "@threa/types"
import type { BotApiKeyService, ValidatedBotApiKey } from "../public-api"
import { createBotSocketAuthMiddleware } from "./socket-auth"

function fakeSocket(opts: { token?: string; headerAuth?: string } = {}): Socket {
  return {
    handshake: {
      auth: opts.token ? { token: opts.token } : {},
      headers: opts.headerAuth ? { authorization: opts.headerAuth } : {},
    },
    data: {},
  } as unknown as Socket
}

function makeKey(overrides: Partial<ValidatedBotApiKey> = {}): ValidatedBotApiKey {
  return {
    id: "key_1",
    workspaceId: "ws_1",
    botId: "bot_alice",
    name: "default",
    scopes: new Set([WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE]),
    ...overrides,
  }
}

describe("createBotSocketAuthMiddleware", () => {
  it("stamps the validated key onto socket.data.bot on success", async () => {
    const service = { validateKey: mock(async () => makeKey()) } as unknown as BotApiKeyService
    const next = mock((_err?: unknown) => {})
    const socket = fakeSocket({ token: "threa_bk_abc" })

    await createBotSocketAuthMiddleware(service)(socket, next)

    expect(next).toHaveBeenCalledWith()
    expect(socket.data.bot).toMatchObject({ workspaceId: "ws_1", botId: "bot_alice", keyId: "key_1" })
  })

  it("rejects when no token is present in handshake.auth or Authorization header", async () => {
    const service = { validateKey: mock(async () => makeKey()) } as unknown as BotApiKeyService
    const next = mock((_err?: unknown) => {})

    await createBotSocketAuthMiddleware(service)(fakeSocket(), next)

    expect((service.validateKey as ReturnType<typeof mock>).mock.calls.length).toBe(0)
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it("falls back to Bearer token in the Authorization header when auth.token is absent", async () => {
    const service = { validateKey: mock(async () => makeKey()) } as unknown as BotApiKeyService
    const next = mock((_err?: unknown) => {})

    await createBotSocketAuthMiddleware(service)(fakeSocket({ headerAuth: "Bearer threa_bk_xyz" }), next)

    expect(service.validateKey).toHaveBeenCalledWith("threa_bk_xyz")
    expect(next).toHaveBeenCalledWith()
  })

  it("rejects when the key fails validation", async () => {
    const service = { validateKey: mock(async () => null) } as unknown as BotApiKeyService
    const next = mock((_err?: unknown) => {})

    await createBotSocketAuthMiddleware(service)(fakeSocket({ token: "threa_bk_bad" }), next)

    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it("rejects keys without BOT_RUNTIME_WRITE scope", async () => {
    const service = {
      validateKey: mock(async () => makeKey({ scopes: new Set([WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ]) })),
    } as unknown as BotApiKeyService
    const next = mock((_err?: unknown) => {})

    await createBotSocketAuthMiddleware(service)(fakeSocket({ token: "threa_bk_readonly" }), next)

    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })

  it("fails closed when validateKey throws", async () => {
    const service = {
      validateKey: mock(async () => {
        throw new Error("DB unreachable")
      }),
    } as unknown as BotApiKeyService
    const next = mock((_err?: unknown) => {})

    await createBotSocketAuthMiddleware(service)(fakeSocket({ token: "threa_bk_x" }), next)

    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })
})
