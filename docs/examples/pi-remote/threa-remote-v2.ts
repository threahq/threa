import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = join(homedir(), ".pi", "agent", "threa-remote.json")
const STATUS_KEY = "threa-remote"
const NO_RESPONSE_MARKER = "THREA_NO_RESPONSE"
const FETCH_TIMEOUT_MS = 30_000
const MAX_FAILURE_POLL_MS = 60_000
const TRACE_CONTENT_MAX_CHARS = 9_500
const PI_TOOL_TRACE_FORMAT = "pi_tool_trace"
const PI_TOOL_TRACE_SECTION_LABELS = {
  ARGUMENTS: "Arguments",
  OUTPUT: "Output",
  ERROR_OUTPUT: "Error output",
  DETAILS: "Details",
} as const

type PiToolTraceSectionLabel = (typeof PI_TOOL_TRACE_SECTION_LABELS)[keyof typeof PI_TOOL_TRACE_SECTION_LABELS]

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
let timer: ReturnType<typeof setTimeout> | undefined
let pollInFlightRunId: number | undefined
let pending: ClaimedInvocation | undefined
let pendingContextCursor: string | undefined
let pendingAssistantTexts: string[] = []
let pendingToolCalls = new Map<string, { headline: string }>()
let lastTraceHeartbeat: { text: string; at: number } | undefined
let consecutivePollFailures = 0
let lastPollFailureSummary: string | undefined
let pollingRunId = 0

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

function setRemoteStatus(ctx: ExtensionContext, text: string, tone: "muted" | "error" = "muted"): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(tone, text))
}

function summarizeError(error: unknown): string {
  const cause =
    error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined
  const causeCode =
    cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code) : ""
  const message = error instanceof Error ? error.message : String(error)
  return [message, causeCode ? `(${causeCode})` : ""].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 180)
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config) throw new Error("Threa remote config not loaded")
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData
  const response = await fetchWithTimeout(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(!isFormData && { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    // Do not read the response body here. Server/proxy failures can return huge
    // HTML documents; surfacing those in Pi eats context and memory.
    throw new Error(`Threa API ${response.status}: ${response.statusText}`)
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

function truncateForTrace(text: string, max = TRACE_CONTENT_MAX_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n\n…[trace content truncated; ${trimmed.length - max} more characters]`
}

async function recordTraceStep(stepType: string, content: string, statusText?: string): Promise<void> {
  if (!config || !pending) return
  const trimmed = truncateForTrace(content)
  if (!trimmed) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${pending.id}/steps`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: pending.claimToken,
      stepType,
      content: trimmed,
      statusText: statusText?.trim().slice(0, 160),
    }),
  }).catch(() => undefined)
}

async function traceHeartbeat(text: string, stepType?: string): Promise<void> {
  if (!pending) return
  const trimmed = safeStatusText(text)
  if (!trimmed) return
  const now = Date.now()
  if (lastTraceHeartbeat?.text === trimmed && now - lastTraceHeartbeat.at < 5000) return
  lastTraceHeartbeat = { text: trimmed, at: now }
  if (stepType) {
    await recordTraceStep(stepType, trimmed, trimmed)
    return
  }
  await heartbeat("busy", trimmed).catch(() => undefined)
}

function safeStatusText(text: string): string {
  const trimmed = text.trim()
  const allowed = new Set([
    "Thinking…",
    "Loaded context…",
    "Running shell command…",
    "Reading file…",
    "Reading sensitive file…",
    "Writing file…",
    "Editing file…",
    "Searching files…",
    "Listing directory…",
    "Using tool…",
    "Tool finished",
    "Tool failed",
    "Composing response…",
    "Sent response",
  ])
  if (allowed.has(trimmed)) return trimmed
  if (/^Finished [A-Za-z0-9_-]+$/.test(trimmed)) return "Tool finished"
  if (/^[A-Za-z0-9_-]+ failed$/.test(trimmed)) return "Tool failed"
  return "Working…"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function basenameFromInputPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1)
}

function isSensitivePath(path: unknown): boolean {
  if (typeof path !== "string") return false
  return /(^|[\\/.])(?:env|npmrc|netrc|pypirc|pgpass|aws|credentials|config|secrets?|tokens?|keys?)(?:$|[.\\/-])/i.test(
    path
  )
}

function safeFileSummary(path: unknown): string {
  if (isSensitivePath(path)) return "sensitive file"
  const name = basenameFromInputPath(path)
  return name ? `file ${name}` : "file"
}

function safeToolName(toolName: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(toolName) ? toolName : "tool"
}

function describeToolCall(event: ToolCallEvent): string {
  const input = "input" in event ? event.input : undefined
  const toolName = safeToolName(event.toolName)
  if (event.toolName === "bash") return "Running shell command…"
  if ((event.toolName === "read" || event.toolName === "write") && isObject(input) && "path" in input) {
    if (event.toolName === "read" && isSensitivePath(input.path)) return "Reading sensitive file…"
    return `${event.toolName === "read" ? "Reading" : "Writing"} ${safeFileSummary(input.path)}…`
  }
  if (event.toolName === "edit" && isObject(input) && "path" in input) return `Editing ${safeFileSummary(input.path)}…`
  if (event.toolName === "grep" || event.toolName === "find") return "Searching files…"
  if (event.toolName === "ls") return "Listing directory…"
  return `Using ${toolName}…`
}

function textFromToolContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object" || !("type" in part)) return ""
      if (part.type === "text" && "text" in part) return String(part.text)
      if (part.type === "image") return "[image output]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function formatStructuredToolTrace(params: {
  headline: string
  sections: Array<{ label: PiToolTraceSectionLabel; body: string; lang: string | null }>
}): string {
  const sections = params.sections.map((section) => ({ ...section, originalBody: section.body }))

  for (let attempt = 0; attempt < 24; attempt++) {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: params.headline,
      sections: sections.map(({ originalBody: _originalBody, ...section }) => section),
    })
    if (payload.length <= TRACE_CONTENT_MAX_CHARS) return payload

    const largestIndex = sections.reduce(
      (largest, section, index) => (section.body.length > sections[largest]!.body.length ? index : largest),
      0
    )
    const largest = sections[largestIndex]
    if (!largest || largest.originalBody.length === 0) break

    const overflow = payload.length - TRACE_CONTENT_MAX_CHARS
    const currentVisibleLength = largest.body.includes("…[section truncated;")
      ? largest.body.indexOf("\n\n…[section truncated;")
      : largest.body.length
    const nextVisibleLength = Math.max(0, currentVisibleLength - Math.max(overflow + 256, 512))
    const omitted = largest.originalBody.length - nextVisibleLength
    largest.body = `${largest.originalBody.slice(0, nextVisibleLength).trimEnd()}\n\n…[section truncated; ${omitted} more characters]`
  }

  return JSON.stringify({
    format: PI_TOOL_TRACE_FORMAT,
    headline: params.headline,
    sections: [
      {
        label: PI_TOOL_TRACE_SECTION_LABELS.DETAILS,
        body: "Trace content was too large to serialize safely.",
        lang: null,
      },
    ],
  })
}

function safeToolArgumentSummary(event: ToolCallEvent): string {
  const input = "input" in event ? event.input : undefined
  const toolName = safeToolName(event.toolName)
  if (event.toolName === "bash") return "Shell command omitted for safety."
  if ((event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") && isObject(input)) {
    const action = event.toolName === "read" ? "Read" : event.toolName === "write" ? "Write" : "Edit"
    return `${action} target: ${"path" in input ? safeFileSummary(input.path) : "file"}. File contents and patches omitted for safety.`
  }
  if (event.toolName === "grep" || event.toolName === "find") return "Search arguments omitted for safety."
  if (event.toolName === "ls") return "Directory listing arguments omitted for safety."
  return `Arguments for ${toolName} omitted for safety.`
}

function formatToolCallTrace(event: ToolCallEvent): string {
  return formatStructuredToolTrace({
    headline: describeToolCall(event).replace(/…$/, ""),
    sections: [
      {
        label: PI_TOOL_TRACE_SECTION_LABELS.DETAILS,
        body: safeToolArgumentSummary(event),
        lang: null,
      },
    ],
  })
}

function summarizeToolOutput(output: string): string {
  const text = output.trim()
  if (!text) return "Tool produced no textual output."
  const lines = text.split("\n").length
  return `Tool output omitted for safety. Captured locally: ${text.length} characters across ${lines} ${lines === 1 ? "line" : "lines"}.`
}

function formatToolResultTrace(event: ToolResultEvent): string {
  const call = pendingToolCalls.get(event.toolCallId)
  const output = textFromToolContent(event.content)
  const sections: Array<{ label: PiToolTraceSectionLabel; body: string; lang: string | null }> = []
  sections.push({
    label: event.isError ? PI_TOOL_TRACE_SECTION_LABELS.ERROR_OUTPUT : PI_TOOL_TRACE_SECTION_LABELS.OUTPUT,
    body: event.isError
      ? `${summarizeToolOutput(output)} Error details omitted for safety.`
      : summarizeToolOutput(output),
    lang: null,
  })
  return formatStructuredToolTrace({ headline: call?.headline ?? `Used ${safeToolName(event.toolName)}`, sections })
}

function sanitizeTraceText(text: string): string {
  return text
    .replace(/, downloaded to [^)\n]+/g, "")
    .replace(/^THREA_ATTACH:\s*.+$/gm, "THREA_ATTACH: [local path omitted]")
}

function formatInvocationTrace(invocation: ClaimedInvocation, context: string): string {
  return truncateForTrace(
    sanitizeTraceText(
      [
        `Remote Threa invocation ${invocation.id}`,
        `Source message: ${invocation.sourceMessageId}`,
        "",
        "Prompt:",
        invocation.promptMarkdown,
        context ? ["", context].join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
  )
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
  pollingRunId += 1
  if (timer) clearTimeout(timer)
  timer = undefined
}

function basePollMs(): number {
  return Math.max(1000, config?.pollMs ?? 3000)
}

function failurePollMs(): number {
  if (consecutivePollFailures <= 0) return basePollMs()
  return Math.min(MAX_FAILURE_POLL_MS, basePollMs() * 2 ** Math.min(consecutivePollFailures - 1, 8))
}

function notePollSuccess(ctx: ExtensionContext): void {
  if (consecutivePollFailures === 0) return
  consecutivePollFailures = 0
  lastPollFailureSummary = undefined
  setRemoteStatus(ctx, pending ? `Threa remote: running ${pending.id}` : "Threa remote: linked")
}

function notePollFailure(ctx: ExtensionContext, error: unknown): void {
  consecutivePollFailures += 1
  const summary = summarizeError(error)
  const retrySeconds = Math.ceil(failurePollMs() / 1000)
  setRemoteStatus(ctx, `Threa remote: failed; retrying in ${retrySeconds}s`, "error")
  if (summary !== lastPollFailureSummary) {
    lastPollFailureSummary = summary
    ctx.ui.notify(`Threa remote connection failed; retrying in background. ${summary}`, "warning")
  }
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

async function claimIfIdle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  if (!config || !isEnabled()) return false
  if (pending) {
    await renewPendingClaim()
    return true
  }
  if (!ctx.isIdle()) return false
  // /claim doubles as the per-tick heartbeat on the server: it refreshes
  // presence as "available" before looking for work and as "busy" if a claim
  // lands. Saves a round trip per poll versus calling /presence separately.
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

  if (!body.data) return true
  pending = body.data
  pendingAssistantTexts = []
  pendingToolCalls = new Map()
  lastTraceHeartbeat = undefined
  const { context, cursor } = await fetchInvocationContext(body.data, ctx.cwd).catch((error) => {
    ctx.ui.notify(`Threa remote context fetch failed: ${summarizeError(error)}`, "warning")
    return { context: "" }
  })
  pendingContextCursor = cursor
  await recordTraceStep("context_received", formatInvocationTrace(body.data, context), "Loaded context…")
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
  return true
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
  const runId = ++pollingRunId
  const poll = async () => {
    if (runId !== pollingRunId) return
    if (pollInFlightRunId !== undefined) {
      timer = setTimeout(() => void poll(), basePollMs())
      return
    }
    pollInFlightRunId = runId
    let delayMs = basePollMs()
    try {
      const contactedServer = await claimIfIdle(pi, ctx)
      if (contactedServer) notePollSuccess(ctx)
    } catch (error) {
      notePollFailure(ctx, error)
      delayMs = failurePollMs()
    } finally {
      if (pollInFlightRunId === runId) pollInFlightRunId = undefined
      if (runId === pollingRunId) timer = setTimeout(() => void poll(), delayMs)
    }
  }
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
  pendingToolCalls = new Map()
  lastTraceHeartbeat = undefined
  await heartbeat("available")
}

async function failPending(error: unknown): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  pending = undefined
  pendingContextCursor = undefined
  pendingAssistantTexts = []
  pendingToolCalls = new Map()
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

export const __testing = {
  describeToolCall,
  formatToolCallTrace,
  formatToolResultTrace,
  safeStatusText,
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
    await traceHeartbeat("Thinking…", "thinking")
  })

  pi.on("tool_call", async (event) => {
    if (!pending) return
    const description = describeToolCall(event)
    pendingToolCalls.set(event.toolCallId, { headline: description.replace(/…$/, "") })
    await recordTraceStep("tool_call", formatToolCallTrace(event), description)
  })

  pi.on("tool_result", async (event) => {
    if (!pending) return
    await recordTraceStep(
      event.isError ? "tool_error" : "tool_call",
      formatToolResultTrace(event),
      event.isError ? `${event.toolName} failed` : `Finished ${event.toolName}`
    )
    pendingToolCalls.delete(event.toolCallId)
  })

  pi.on("tool_execution_end", async (event) => {
    if (!event.isError || !pendingToolCalls.has(event.toolCallId)) return
    await traceHeartbeat(`${event.toolName} failed`, "tool_error")
    pendingToolCalls.delete(event.toolCallId)
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
      const finalText =
        pendingAssistantTexts.length > 0 ? pendingAssistantTexts.join("\n\n") : textFromAgentMessages(event.messages)
      const traceFinalText = extractAttachmentDirectives(finalText).markdown || NO_RESPONSE_MARKER
      await recordTraceStep("message_sent", `Final response:\n\n${sanitizeTraceText(traceFinalText)}`, "Sent response")
      await completePending(finalText, ctx.cwd)
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
