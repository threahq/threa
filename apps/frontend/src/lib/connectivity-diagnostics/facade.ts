import type { ConnectivityEvent, ConnectivityObservation, DiagnosticFields, RoomCategory, RouteCategory } from "./index"

interface ConnectivityDiagnosticsRuntime {
  begin(fields?: DiagnosticFields): ConnectivityObservation
  flush(): Promise<boolean>
  record(event: ConnectivityEvent, fields?: DiagnosticFields): void
  suspend(): void
}

let runtime: ConnectivityDiagnosticsRuntime | null = null

export function registerConnectivityDiagnosticsRuntime(next: ConnectivityDiagnosticsRuntime): void {
  runtime = next
}

export function createDiagnosticId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    const bytes = new Uint8Array(16)
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

export function categorizeRoute(path: string): RouteCategory {
  let pathname = path.split("?", 1)[0] ?? ""
  try {
    pathname = new URL(path).pathname
  } catch {}
  if (/^\/api\/workspaces\/[^/]+\/config$/.test(pathname)) return "workspace_config"
  if (/^\/api\/workspaces\/[^/]+\/agent-sessions\/[^/]+(?:\/|$)/.test(pathname)) return "agent_trace"
  if (pathname.includes("/attachments")) return "attachments"
  if (pathname.endsWith("/avatar")) return "avatars"
  if (pathname.includes("/messages")) return "messages"
  if (pathname.includes("/streams")) return "streams"
  if (pathname.includes("/sync")) return "sync"
  return "other"
}

export function categorizeRoom(room: string): RoomCategory {
  if (/^ws:[^:]+:stream:[^:]+$/.test(room)) return "stream"
  if (/^ws:[^:]+:agent_session:[^:]+$/.test(room)) return "agent_session"
  if (/^ws:[^:]+$/.test(room)) return "workspace"
  return "other"
}

const socketContexts = new WeakMap<object, { connectionId: string; generation: number }>()

export function setSocketDiagnosticContext(
  socket: object,
  context: { connectionId: string; generation: number }
): void {
  socketContexts.set(socket, context)
}

export function getSocketDiagnosticContext(socket: object): { connectionId: string; generation: number } | undefined {
  return socketContexts.get(socket)
}

const NOOP_OBSERVATION: ConnectivityObservation = { id: "", record: () => {}, stall: () => () => {} }

export function beginConnectivityObservation(fields: DiagnosticFields = {}): ConnectivityObservation {
  return runtime?.begin(fields) ?? NOOP_OBSERVATION
}

export function recordConnectivityEvent(event: ConnectivityEvent, fields: DiagnosticFields = {}): void {
  runtime?.record(event, fields)
}

export function flushConnectivityDiagnostics(): Promise<boolean> {
  return runtime?.flush() ?? Promise.resolve(true)
}

export function suspendConnectivityDiagnostics(): void {
  runtime?.suspend()
}

export type { ConnectivityEvent, ConnectivityObservation, DiagnosticFields, RoomCategory, RouteCategory }
