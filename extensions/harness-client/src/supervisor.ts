import * as socketIoClient from "socket.io-client"
import type { Socket } from "socket.io-client"
import { buildBotSocketUrl, isObject, parseWsHint, type WsHint } from "@threa/bot-runtime-client"

const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const DEFAULT_RECONNECTION_DELAY_MAX_MS = 30_000

export interface BotSessionRestoredPayload {
  botId: string
  instanceId: string
  runtimeSessionId: string
  rootStreamId: string
}

export interface BotSupervisorTransportOptions {
  baseUrl: string
  workspaceId: string
  apiKey: string
  onReady: () => void
  onSessionRestored: (payload: BotSessionRestoredPayload) => void
  log?: (message: string) => void
  fetchTimeoutMs?: number
  reconnectionDelayMaxMs?: number
}

/**
 * Side-effect-free `/bot` subscriber for local supervisors. Unlike
 * `BotRuntimeTransport`, it never sends `bot:hello`, writes presence, advertises
 * capabilities, or joins invocation rooms.
 */
export class BotSupervisorTransport {
  private readonly base: string
  private readonly opts: BotSupervisorTransportOptions
  private socket: Socket | undefined
  private connecting = false
  private stopped = false

  constructor(opts: BotSupervisorTransportOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "")
    this.opts = opts
  }

  async connect(): Promise<void> {
    if (this.connecting || this.stopped || this.socket) return
    this.connecting = true
    try {
      const hint = await this.resolveWsHint().catch((error) => {
        this.log(`ws hint resolve failed: ${summarize(error)}`)
        return undefined
      })
      if (hint) this.attachSocket(hint)
    } finally {
      this.connecting = false
    }
  }

  disconnect(): void {
    this.stopped = true
    const socket = this.socket
    this.socket = undefined
    if (!socket) return
    socket.removeAllListeners()
    socket.disconnect()
  }

  private attachSocket(hint: WsHint): void {
    let socket: Socket
    try {
      socket = socketIoClient.io(buildBotSocketUrl(hint), {
        path: hint.path,
        auth: { token: this.opts.apiKey },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelayMax: this.opts.reconnectionDelayMaxMs ?? DEFAULT_RECONNECTION_DELAY_MAX_MS,
      })
    } catch (error) {
      this.log(`socket attach failed: ${summarize(error)}`)
      return
    }
    this.socket = socket
    socket.on("connect", () => {
      socket.timeout(5_000).emit("bot:supervisor:subscribe", (error: unknown, ack: unknown) => {
        if (error || !isObject(ack) || ack.ok !== true) {
          this.log(
            `supervisor subscribe rejected: ${error ? summarize(error) : String(isObject(ack) ? ack.error : ack)}`
          )
          this.dropSocket(socket)
          return
        }
        this.opts.onReady()
      })
    })
    socket.on("disconnect", (reason: string) => {
      if (reason === "io server disconnect") socket.connect()
    })
    socket.on("connect_error", (error: unknown) => {
      this.log(`socket connect_error: ${summarize(error)}`)
      this.dropSocket(socket)
    })
    socket.on("bot:session_restored", (payload: unknown) => {
      const restored = parseRestoredPayload(payload)
      if (restored) this.opts.onSessionRestored(restored)
    })
  }

  private dropSocket(socket: Socket): void {
    if (this.socket !== socket) return
    this.socket = undefined
    socket.removeAllListeners()
    socket.disconnect()
  }

  private async resolveWsHint(): Promise<WsHint | undefined> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.base}/api/workspaces/${this.opts.workspaceId}/config`, {
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        signal: controller.signal,
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as { wsUrl?: string }
      return parseWsHint({ url: body.wsUrl })
    } finally {
      clearTimeout(timeout)
    }
  }

  private log(message: string): void {
    this.opts.log?.(message)
  }
}

function parseRestoredPayload(payload: unknown): BotSessionRestoredPayload | undefined {
  if (!isObject(payload)) return undefined
  const { botId, instanceId, runtimeSessionId, rootStreamId } = payload
  if ([botId, instanceId, runtimeSessionId, rootStreamId].some((value) => typeof value !== "string" || !value)) {
    return undefined
  }
  return { botId, instanceId, runtimeSessionId, rootStreamId } as BotSessionRestoredPayload
}

function summarize(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200)
}
