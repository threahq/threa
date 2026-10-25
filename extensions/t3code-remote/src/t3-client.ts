import { T3AuthError, type FetchLike } from "./auth"
import type { T3Access } from "./config"

const PROTOCOL_VERSION = "2025-06-18"
// A hung connection fails the call instead of stalling its turn forever; T3's slowest answers (a launch) take seconds.
const REQUEST_TIMEOUT_MS = 60_000

export type RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back"

export interface ModelOption {
  id: string
  value: string | boolean
}

export interface ModelSelection {
  instanceId: string
  model: string
  options?: ModelOption[]
}

/** A setting a model offers, like its reasoning effort; `options` lists a select's values. */
export interface ModelOptionDescriptor {
  id: string
  type: "select" | "boolean"
  options?: Array<{ id: string }>
}

export interface ThreadItem {
  position: number
  itemId: string
  runId: string | null
  /** `inherited` items are a forked thread's view of its source, and keep the source's run ids. */
  visibility: "local" | "inherited" | "synthetic"
  type: string
  status: string | null
  title: string | null
  text: string | null
  nextTextOffset: number | null
}

export interface ThreadSummary {
  threadId: string
  title: string
  status: RunStatus | "idle"
  /** The thread's newest run, queued ones included. */
  latestRunId: string | null
  providerInstanceId: string
  model: string
  archived: boolean
}

export interface ImageAttachment {
  type: "image"
  id: string
  name: string
  mimeType: string
  sizeBytes: number
}

export interface PendingQuestion {
  id: string
  header: string
  question: string
  options: Array<{ label: string; description: string; value?: string }>
  multiSelect?: boolean
  /** Unset allows a custom answer. */
  allowCustomAnswer?: boolean
  /** Unset is required. */
  required?: boolean
}

export interface ProviderInfo {
  providerInstanceId: string
  displayName?: string
  models: Array<{ id: string; label?: string; options?: ModelOptionDescriptor[] }>
}

/** The orchestrator tools the connector calls, with the slice of each argument and result it uses. */
export interface T3Tools {
  t3_thread_launch: {
    args: {
      title: string
      message: string
      runtimeMode: T3Access
      projectId?: string
      scratch?: boolean
      modelSelection?: ModelSelection
      attachments?: ImageAttachment[]
      workspaceStrategy?: { type: "worktree"; baseRef: string; startFromOrigin: boolean }
    }
    result: { threadId: string; runId: string | null }
  }
  t3_thread_send: {
    args: { threadId: string; message: string; mode: "queue" | "steer"; clientRequestId?: string }
    result: { runId: string; status: RunStatus; delivery: "started" | "queued" | "steered" | "restarted" }
  }
  /** Sends in T3's "auto" mode: steers the thread's steerable run, else starts one. */
  t3_thread_send_attachments: {
    args: { threadId: string; message: string; attachments: ImageAttachment[] }
    result: { runId: string; status: RunStatus }
  }
  t3_attachment_prepare_upload: {
    args: { upload: { type: "image"; name: string; mimeType: string; sizeBytes: number } }
    /** `relativeUrl` is signed: POSTing the bytes there needs no bearer token. */
    result: { attachmentId: string; relativeUrl: string }
  }
  t3_thread_wait: {
    args: { threadId: string; runId: string; timeoutMs: number }
    /** Past a restart, the run that continues the one waited on. */
    result: { runId: string | null; status: RunStatus | "idle"; timedOut: boolean }
  }
  t3_thread_read: {
    args: {
      threadId: string
      view?: "activity"
      afterPosition?: number
      limit?: number
      maxCharsPerItem?: number
      itemId?: string
      textOffset?: number
    }
    result: { thread: ThreadSummary; items: ThreadItem[]; nextPosition: number | null; hasMore: boolean }
  }
  t3_thread_interrupt: {
    args: { threadId: string; runId?: string; reason?: string }
    result: { status: string }
  }
  t3_pending_request_list: {
    args: { threadId: string }
    /** Pending user questions only; approvals are not listed. */
    result: { requestIds: string[] }
  }
  t3_pending_request_read: {
    args: { threadId: string; requestId: string }
    result: { requestId: string; questions: PendingQuestion[] }
  }
  t3_pending_request_respond: {
    /** Keyed by question id; every provider takes a string answer. */
    args: { threadId: string; requestId: string; answers: Record<string, string> }
    result: unknown
  }
  t3_thread_configuration: {
    args: { threadId: string }
    result: { modelSelection: ModelSelection; runtimeMode: T3Access }
  }
  t3_thread_configure: {
    args: { threadId: string; modelSelection: ModelSelection }
    result: { sequence: number }
  }
  t3_thread_organize: {
    args: { threadId: string; action: "archive" }
    result: unknown
  }
  t3_thread_fork: {
    args: { threadId: string; sourcePoint: { type: "latest_stable" }; title: string }
    result: { targetThreadId: string }
  }
  orchestrator_capabilities: {
    args: Record<string, never>
    result: { providers: ProviderInfo[] }
  }
  t3_environment_read: {
    args: Record<string, never>
    result: { preferences: { defaultThreadEnvMode?: "local" | "worktree"; newWorktreesStartFromOrigin: boolean } }
  }
}

export type T3ToolName = keyof T3Tools

/** The orchestrator refused a tool call; `code` is its failure tag (e.g. `thread_not_sendable`). */
export class T3ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string | undefined,
    message: string
  ) {
    super(message)
  }
}

export interface T3TokenSource {
  token(): Promise<string>
  renew(rejected: string): Promise<string>
}

interface JsonRpcMessage {
  id?: number
  result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text?: string }> }
  error?: { message?: string }
}

/** Streamable-HTTP MCP client for T3 Code's `/mcp`: one lazily initialized session, re-opened once if the server drops it. */
export class T3Client {
  private sessionId?: string
  private opening?: Promise<void>
  private nextId = 1
  private readonly fetchImpl: FetchLike

  constructor(
    readonly baseUrl: string,
    private readonly auth: T3TokenSource,
    fetchImpl?: FetchLike
  ) {
    this.fetchImpl = fetchImpl ?? fetch
  }

  async call<K extends T3ToolName>(name: K, args: T3Tools[K]["args"]): Promise<T3Tools[K]["result"]> {
    await this.open()
    let message: JsonRpcMessage | undefined
    try {
      message = await this.rpc("tools/call", { name, arguments: args })
    } catch (error) {
      if (!(error instanceof SessionLostError)) throw error
      // A concurrent call may have re-opened the session already.
      if (this.sessionId === error.sessionId) this.sessionId = undefined
      await this.open()
      message = await this.rpc("tools/call", { name, arguments: args })
    }
    const result = message?.result
    if (!result) throw new Error(`T3 Code ${name} returned no result`)
    if (result.isError) throw toolError(name, result.content?.[0]?.text)
    return result.structuredContent as T3Tools[K]["result"]
  }

  async upload(relativeUrl: string, bytes: Uint8Array): Promise<void> {
    const res = await this.fetchImpl(new URL(relativeUrl, this.baseUrl).href, {
      method: "POST",
      body: bytes,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (res.status !== 204)
      throw new Error(`T3 Code upload answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  private open(): Promise<void> {
    if (this.sessionId) return Promise.resolve()
    this.opening ??= (async () => {
      await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "threa-t3code", version: "0.1.0" },
      })
      await this.rpc("notifications/initialized", undefined, true)
    })().finally(() => (this.opening = undefined))
    return this.opening
  }

  private async rpc(method: string, params: unknown, notify = false): Promise<JsonRpcMessage | undefined> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params, ...(notify ? {} : { id: this.nextId++ }) })
    const token = await this.auth.token()
    const sessionId = method === "initialize" ? undefined : this.sessionId
    let res = await this.post(body, token, sessionId)
    if (res.status === 401) res = await this.post(body, await this.auth.renew(token), sessionId)
    if (res.status === 401) throw new T3AuthError("T3 Code rejected a freshly minted token.")
    if (res.status === 404 && sessionId !== undefined) throw new SessionLostError(sessionId)
    this.sessionId = res.headers.get("mcp-session-id") ?? this.sessionId
    const text = await res.text()
    if (!res.ok) throw new Error(`T3 Code MCP ${method} answered ${res.status}: ${text.slice(0, 300)}`)
    if (notify || !text) return undefined
    const message = res.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as JsonRpcMessage)
          .find((candidate) => candidate.id !== undefined)
      : (JSON.parse(text) as JsonRpcMessage)
    if (message?.error) throw new Error(`T3 Code MCP ${method} failed: ${message.error.message ?? "unknown error"}`)
    return message
  }

  private post(body: string, token: string, sessionId: string | undefined): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }
}

class SessionLostError extends Error {
  constructor(readonly sessionId: string) {
    super("T3 Code dropped the MCP session again right after it was re-opened.")
  }
}

function toolError(tool: string, text: string | undefined): T3ToolError {
  try {
    const parsed = JSON.parse(text ?? "") as { code?: unknown; message?: unknown }
    const code = typeof parsed.code === "string" ? parsed.code : undefined
    const message = typeof parsed.message === "string" ? parsed.message : (text ?? "")
    return new T3ToolError(tool, code, `T3 Code ${tool} failed: ${message}`)
  } catch {
    return new T3ToolError(tool, undefined, `T3 Code ${tool} failed: ${text ?? "no detail"}`)
  }
}
