import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = join(homedir(), ".pi", "agent", "threa-remote.json")
const STATUS_KEY = "threa-remote"
const NO_RESPONSE_MARKER = "THREA_NO_RESPONSE"

type Config = {
  baseUrl: string
  workspaceId: string
  apiKey: string
  pollMs?: number
  instanceId?: string
  defaultDisplayName?: string
  enabled?: boolean
  linkedSessions?: Record<string, RuntimeSessionLink>
  streamCursors?: Record<string, string>
}

type RuntimeSessionLink = {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
}

type ClaimedInvocation = {
  id: string
  activeStreamId: string
  sourceMessageId: string
  promptMarkdown: string
  claimToken: string
  claimExpiresAt: string | null
}

interface AttachmentSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

interface StreamMessage {
  id: string
  authorType: string
  authorDisplayName?: string
  sequence: string
  content: string
  createdAt: string
  attachments?: AttachmentSummary[]
}

interface UploadedAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

let config: Config | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pollInFlight = false
let pending: ClaimedInvocation | undefined
let pendingContextCursor: string | undefined
let pendingAssistantTexts: string[] = []
let lastTraceHeartbeat: { text: string; at: number } | undefined

function validateConfig(value: unknown): Config | undefined {
  if (!value || typeof value !== "object") {
    console.error(`Invalid ${CONFIG_PATH}: expected an object`)
    return undefined
  }
  const candidate = value as Partial<Config>
  const invalidFields = ["baseUrl", "workspaceId", "apiKey"].filter((field) => {
    const fieldValue = candidate[field as keyof Config]
    return typeof fieldValue !== "string" || fieldValue.trim().length === 0
  })
  if (invalidFields.length > 0) {
    console.error(`Invalid ${CONFIG_PATH}: missing or invalid ${invalidFields.join(", ")}`)
    return undefined
  }
  return candidate as Config
}

function readConfig(): Config | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    return validateConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")))
  } catch (error) {
    console.error(`Failed to parse ${CONFIG_PATH}: ${String(error)}`)
    return undefined
  }
}

function saveConfig(): void {
  if (!config) return
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

function ensureInstanceId(): string {
  if (!config) throw new Error("Threa remote config not loaded")
  if (config.instanceId) return config.instanceId
  config.instanceId = `pi-${hostname()}-${crypto.randomUUID().slice(0, 8)}`
  saveConfig()
  return config.instanceId
}

function setRemoteStatus(ctx: ExtensionContext, text: string): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("muted", text))
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config) throw new Error("Threa remote config not loaded")
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(!isFormData && { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Threa API ${response.status}: ${body || response.statusText}`)
  }
  return (await response.json()) as T
}

async function heartbeat(status: "available" | "busy" | "offline" | "error", statusText?: string): Promise<void> {
  if (!config) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-runtime/presence`, {
    method: "POST",
    body: JSON.stringify({
      runtimeKind: "pi-local",
      instanceId: ensureInstanceId(),
      displayName: config.defaultDisplayName,
      status,
      acceptingInvocations: status === "available",
      capabilities: {
        supportsActiveScratchpad: true,
        supportsPersistentSessions: true,
        supportsMentionInvocations: true,
      },
      statusText,
    }),
  })
}

async function traceHeartbeat(text: string): Promise<void> {
  if (!pending) return
  const trimmed = text.trim().slice(0, 160)
  if (!trimmed) return
  const now = Date.now()
  if (lastTraceHeartbeat?.text === trimmed && now - lastTraceHeartbeat.at < 5000) return
  lastTraceHeartbeat = { text: trimmed, at: now }
  await heartbeat("busy", trimmed).catch(() => undefined)
}

function describeToolCall(event: ToolCallEvent): string {
  const input = "input" in event ? event.input : undefined
  if (event.toolName === "bash" && input && typeof input === "object" && "command" in input) {
    return `Running ${String(input.command).split("\n")[0].slice(0, 80)}…`
  }
  if (
    (event.toolName === "read" || event.toolName === "write") &&
    input &&
    typeof input === "object" &&
    "path" in input
  ) {
    return `${event.toolName === "read" ? "Reading" : "Writing"} ${String(input.path).slice(0, 80)}…`
  }
  if (event.toolName === "edit" && input && typeof input === "object" && "path" in input) {
    return `Editing ${String(input.path).slice(0, 80)}…`
  }
  if (
    (event.toolName === "grep" || event.toolName === "find") &&
    input &&
    typeof input === "object" &&
    "pattern" in input
  ) {
    return `Searching for ${String(input.pattern).slice(0, 80)}…`
  }
  if (event.toolName === "ls" && input && typeof input === "object" && "path" in input) {
    return `Listing ${String(input.path).slice(0, 80)}…`
  }
  return `Using ${event.toolName}…`
}

function describeToolEnd(event: ToolExecutionEndEvent): string {
  return event.isError ? `${event.toolName} failed` : `Finished ${event.toolName}`
}

async function createRemoteSession(ctx: ExtensionCommandContext, args: string): Promise<void> {
  if (!config) throw new Error("Threa remote config not loaded")
  const runtimeSessionId = ctx.sessionManager.getSessionId() ?? `pi-session-${Date.now()}`
  const displayName = args.trim() || config.defaultDisplayName || ctx.cwd.split("/").pop() || "Pi"

  const body = await request<{ data: RuntimeSessionLink }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        runtimeKind: "pi-local",
        instanceId: ensureInstanceId(),
        runtimeSessionId,
        displayName,
        localCwd: ctx.cwd,
      }),
    }
  )

  config.linkedSessions ??= {}
  config.linkedSessions[runtimeSessionId] = body.data
  saveConfig()

  ctx.ui.notify(`Threa remote linked: ${body.data.streamUrlPath}`, "info")
  setRemoteStatus(ctx, `Threa remote: ${displayName}`)
  await heartbeat("available")
}

async function renewPendingClaim(): Promise<void> {
  if (!config || !pending) return
  const body = await request<{ data: { claimExpiresAt: string | null } }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-invocations/${pending.id}/renew`,
    {
      method: "POST",
      body: JSON.stringify({
        instanceId: ensureInstanceId(),
        claimToken: pending.claimToken,
        claimTtlSeconds: 120,
      }),
    }
  )
  pending.claimExpiresAt = body.data.claimExpiresAt
}

function isEnabled(): boolean {
  return config?.enabled !== false
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = undefined
  pollInFlight = false
}

async function disableRemote(ctx: ExtensionContext): Promise<void> {
  if (!config) return
  config.enabled = false
  saveConfig()
  stopPolling()
  await failPending("Threa remote disabled")
  await heartbeat("offline").catch(() => undefined)
  setRemoteStatus(ctx, "Threa remote: off")
  ctx.ui.notify("Threa remote disabled", "info")
}

async function enableRemote(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!config) return
  config.enabled = true
  saveConfig()
  await heartbeat("available")
  startPolling(pi, ctx)
  ctx.ui.notify("Threa remote enabled", "info")
}

function formatInvocationContext(
  messages: StreamMessage[],
  sourceMessageId: string,
  downloadedAttachments: Map<string, string>
): string {
  if (messages.length === 0) return ""
  const orderedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return [
    "Recent Threa stream context (oldest first):",
    ...orderedMessages.map((message) => {
      const author = message.authorDisplayName || message.authorType
      const marker = message.id === sourceMessageId ? " [source]" : ""
      const attachments = (message.attachments ?? [])
        .map((attachment) => {
          const localPath = downloadedAttachments.get(attachment.id)
          const localNote = localPath ? `, downloaded to ${localPath}` : ""
          return `[${attachment.id}] ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes${localNote})`
        })
        .join("; ")
      return `- ${author}${marker}: ${message.content}${attachments ? `\n  Attachments: ${attachments}` : ""}`
    }),
  ].join("\n")
}

function safeFilename(filename: string): string {
  return filename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) || "attachment"
}

async function downloadAttachment(
  attachment: AttachmentSummary,
  invocation: ClaimedInvocation,
  cwd: string
): Promise<string> {
  if (!config) throw new Error("Threa remote config not loaded")
  const body = await request<{ data: { url: string } }>(
    `/api/v1/workspaces/${config.workspaceId}/attachments/${attachment.id}/url`
  )
  const response = await fetch(body.data.url)
  if (!response.ok) throw new Error(`download failed with ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const dir = join(cwd, ".threa-attachments", invocation.id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, safeFilename(attachment.filename))
  writeFileSync(path, bytes)
  return path
}

async function downloadContextAttachments(
  messages: StreamMessage[],
  invocation: ClaimedInvocation,
  cwd: string
): Promise<Map<string, string>> {
  const downloaded = new Map<string, string>()
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      try {
        downloaded.set(attachment.id, await downloadAttachment(attachment, invocation, cwd))
      } catch (error) {
        console.warn(`Failed to download Threa attachment ${attachment.id}: ${String(error)}`)
      }
    }
  }
  return downloaded
}

async function fetchInvocationContext(
  invocation: ClaimedInvocation,
  cwd: string
): Promise<{ context: string; cursor?: string }> {
  if (!config) return { context: "" }
  const cursor = config.streamCursors?.[invocation.activeStreamId]
  const query = cursor ? `after=${encodeURIComponent(cursor)}&limit=50` : "limit=12"
  const body = await request<{ data: StreamMessage[] }>(
    `/api/v1/workspaces/${config.workspaceId}/streams/${invocation.activeStreamId}/messages?${query}`
  )

  let sourceIncluded = body.data.some((message) => message.id === invocation.sourceMessageId)
  const messages = sourceIncluded
    ? body.data
    : (
        await request<{ data: StreamMessage[] }>(
          `/api/v1/workspaces/${config.workspaceId}/streams/${invocation.activeStreamId}/messages?limit=12`
        )
      ).data
  sourceIncluded = messages.some((message) => message.id === invocation.sourceMessageId)
  const orderedMessages = [...messages].sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))
  const downloadedAttachments = await downloadContextAttachments(orderedMessages, invocation, cwd)

  return {
    context: formatInvocationContext(orderedMessages, invocation.sourceMessageId, downloadedAttachments),
    cursor: sourceIncluded ? orderedMessages.at(-1)?.sequence : undefined,
  }
}

async function claimIfIdle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!config || !isEnabled()) return
  if (pending) {
    await renewPendingClaim()
    return
  }
  if (!ctx.isIdle()) return
  await heartbeat("available")

  const body = await request<{ data: ClaimedInvocation | null }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-invocations/claim`,
    {
      method: "POST",
      body: JSON.stringify({
        runtimeKind: "pi-local",
        instanceId: ensureInstanceId(),
        supportedCapabilities: ["active-scratchpad", "mentionable"],
        claimTtlSeconds: 120,
      }),
    }
  )

  if (!body.data) return
  pending = body.data
  pendingAssistantTexts = []
  lastTraceHeartbeat = undefined
  const { context, cursor } = await fetchInvocationContext(body.data, ctx.cwd).catch((error) => {
    ctx.ui.notify(`Threa remote context fetch failed: ${String(error)}`, "warning")
    return { context: "" }
  })
  pendingContextCursor = cursor
  await heartbeat("busy", "Starting…")
  setRemoteStatus(ctx, `Threa remote: running ${body.data.id}`)
  pi.sendUserMessage(
    [
      `Remote Threa invocation ${body.data.id}.`,
      `Source message: ${body.data.sourceMessageId}`,
      "Respond normally; the extension will post your final answer back to Threa.",
      "To attach a local file to your reply, add a line exactly like `THREA_ATTACH: path/to/file`; the extension will upload it and replace it with an attachment link.",
      context ? `\n${context}` : "",
      "\nSource message prompt:",
      body.data.promptMarkdown,
    ].join("\n")
  )
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return String(part.text)
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function textFromAssistantMessage(message: unknown): string {
  if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") return ""
  if (!("content" in message)) return ""
  return textFromContent(message.content).trim()
}

function textFromAgentMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "Done."
  const text = messages.map(textFromAssistantMessage).filter(Boolean).join("\n\n").trim()
  return text || "Done."
}

function startPolling(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!isEnabled()) return
  stopPolling()
  const poll = async () => {
    if (pollInFlight) return
    pollInFlight = true
    try {
      await claimIfIdle(pi, ctx)
    } catch (error) {
      ctx.ui.notify(`Threa remote poll failed: ${String(error)}`, "warning")
    } finally {
      pollInFlight = false
    }
  }
  timer = setInterval(() => void poll(), Math.max(1000, config?.pollMs ?? 3000))
  void poll()
}

function advanceStreamCursor(invocation: ClaimedInvocation): void {
  if (!config || !pendingContextCursor) return
  config.streamCursors ??= {}
  config.streamCursors[invocation.activeStreamId] = pendingContextCursor
  saveConfig()
}

function extractAttachmentDirectives(markdown: string): { markdown: string; paths: string[] } {
  const paths: string[] = []
  const lines = markdown.split("\n").filter((line) => {
    const match = line.match(/^THREA_ATTACH:\s*(.+?)\s*$/)
    if (!match) return true
    paths.push(match[1])
    return false
  })
  return { markdown: lines.join("\n").trim(), paths }
}

function guessMimeType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".html")) return "text/html"
  if (lower.endsWith(".md")) return "text/markdown"
  if (lower.endsWith(".txt")) return "text/plain"
  if (lower.endsWith(".csv")) return "text/csv"
  if (lower.endsWith(".pdf")) return "application/pdf"
  return "application/octet-stream"
}

async function uploadAttachment(path: string, cwd: string): Promise<UploadedAttachment> {
  if (!config) throw new Error("Threa remote config not loaded")
  const absolutePath = resolve(cwd, path)
  const stats = statSync(absolutePath)
  if (!stats.isFile()) throw new Error(`${path} is not a file`)
  const form = new FormData()
  const bytes = readFileSync(absolutePath)
  form.append("file", new Blob([bytes], { type: guessMimeType(absolutePath) }), basename(absolutePath))
  const body = await request<{ data: UploadedAttachment }>(`/api/v1/workspaces/${config.workspaceId}/attachments`, {
    method: "POST",
    body: form,
  })
  return body.data
}

async function prepareFinalMarkdown(
  markdown: string,
  cwd: string
): Promise<{ finalMarkdown: string; uploadedAttachments: UploadedAttachment[] }> {
  const extracted = extractAttachmentDirectives(markdown.trim())
  const uploadedAttachments: UploadedAttachment[] = []
  const failedUploads: string[] = []
  for (const path of extracted.paths) {
    try {
      uploadedAttachments.push(await uploadAttachment(path, cwd))
    } catch (error) {
      failedUploads.push(`${path}: ${String(error)}`)
    }
  }
  const attachmentLinks = uploadedAttachments.map(
    (attachment) => `- [${attachment.filename}](attachment:${attachment.id})`
  )
  const uploadFailureNote =
    failedUploads.length > 0
      ? ["Attachment upload failed:", ...failedUploads.map((failure) => `- ${failure}`)].join("\n")
      : ""
  return {
    finalMarkdown:
      [
        extracted.markdown || "Done.",
        attachmentLinks.length > 0 ? "Attachments:" : "",
        ...attachmentLinks,
        uploadFailureNote,
      ]
        .filter(Boolean)
        .join("\n\n") || "Done.",
    uploadedAttachments,
  }
}

async function completePending(markdown: string, cwd: string): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  const { finalMarkdown, uploadedAttachments } = await prepareFinalMarkdown(markdown, cwd)
  const noResponse = finalMarkdown === NO_RESPONSE_MARKER
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      ...(noResponse ? { noResponse: true } : { finalMessageMarkdown: finalMarkdown }),
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": ensureInstanceId(),
        ...(noResponse && { "pi.remote.noResponse": "true" }),
        ...(uploadedAttachments.length > 0 && {
          "pi.remote.attachmentIds": uploadedAttachments.map((attachment) => attachment.id).join(","),
        }),
      },
    }),
  })
  advanceStreamCursor(invocation)
  pending = undefined
  pendingContextCursor = undefined
  pendingAssistantTexts = []
  lastTraceHeartbeat = undefined
  await heartbeat("available")
}

async function failPending(error: unknown): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  pending = undefined
  pendingContextCursor = undefined
  pendingAssistantTexts = []
  lastTraceHeartbeat = undefined
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/fail`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      errorMessage: String(error).slice(0, 1000),
    }),
  }).catch(() => undefined)
  await heartbeat("available").catch(() => undefined)
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("remote-control", {
    description: "Create or link a Threa scratchpad to this Pi session",
    handler: async (args, ctx) => {
      config = readConfig()
      if (!config) {
        ctx.ui.notify(`Missing ${CONFIG_PATH}`, "warning")
        return
      }
      const command = args.trim().toLowerCase()
      if (command === "off" || command === "disable") {
        await disableRemote(ctx)
        return
      }
      if (command === "on" || command === "enable") {
        await enableRemote(pi, ctx)
        return
      }
      if (command === "status") {
        ctx.ui.notify(`Threa remote is ${isEnabled() ? "on" : "off"}${pending ? ` (${pending.id})` : ""}`, "info")
        return
      }
      config.enabled = true
      await createRemoteSession(ctx, args)
      startPolling(pi, ctx)
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    config = readConfig()
    if (!config) return
    if (!isEnabled()) {
      setRemoteStatus(ctx, "Threa remote: off")
      return
    }
    await heartbeat("available")
    startPolling(pi, ctx)
  })

  pi.on("agent_start", async () => {
    await traceHeartbeat("Thinking…")
  })

  pi.on("tool_call", async (event) => {
    await traceHeartbeat(describeToolCall(event))
  })

  pi.on("tool_execution_end", async (event) => {
    await traceHeartbeat(describeToolEnd(event))
  })

  pi.on("message_start", async (event) => {
    if (!pending || event.message.role !== "assistant") return
    await traceHeartbeat("Composing response…")
  })

  pi.on("message_end", async (event) => {
    if (!pending) return
    const text = textFromAssistantMessage(event.message)
    if (!text) return
    pendingAssistantTexts.push(text)
  })

  pi.on("agent_end", async (event, ctx) => {
    if (!pending) return
    try {
      await completePending(
        pendingAssistantTexts.length > 0 ? pendingAssistantTexts.join("\n\n") : textFromAgentMessages(event.messages),
        ctx.cwd
      )
      setRemoteStatus(ctx, "Threa remote: linked")
    } catch (error) {
      ctx.ui.notify(`Failed to complete Threa invocation: ${String(error)}`, "warning")
      await failPending(error)
    }
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPolling()
    await failPending("Pi session shut down")
    await heartbeat("offline").catch(() => undefined)
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
