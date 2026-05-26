import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname, platform } from "node:os"
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
const BUSY_HEARTBEAT_MS = 15_000
const TRACE_CONTENT_MAX_CHARS = 9_500
const MAX_AUTO_RETRY_MS = 4 * 60 * 60 * 1000
const MAX_RETRY_ATTEMPTS = 3
const PI_TOOL_TRACE_FORMAT = "pi_tool_trace"
const SESSION_CONTROL_CAPABILITY = "session-control"
const SESSION_CONTROL_COMMANDS = ["compact", "model", "thinking", "skill", "reload"] as const
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]
const execFileAsync = promisify(execFile)
const OPEN_URL_TIMEOUT_MS = 10_000

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
  /** Pinned model identifiers (`provider/id`) rendered first by /model. */
  preferredModels?: string[]
  /** Legacy global flag; migrated to per-session link state on write. */
  enabled?: boolean
  linkedSessions?: Record<string, RuntimeSessionLink>
  /** Legacy global cursors; migrated to per-session link state on write. */
  streamCursors?: Record<string, string>
}

type RuntimeSessionLink = {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
  enabled?: boolean
  debugPolling?: boolean
  streamCursors?: Record<string, string>
}

type ConfigPatch = Pick<
  Config,
  "baseUrl" | "workspaceId" | "apiKey" | "pollMs" | "defaultDisplayName" | "preferredModels"
>

type ClaimedInvocation = {
  id: string
  activeStreamId: string
  sourceMessageId: string
  promptMarkdown: string
  claimToken: string
  claimExpiresAt: string | null
  trigger?: string
  requiredCapability?: string
  metadata?: Record<string, unknown>
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

interface BotPrincipal {
  kind: "bot"
  workspaceId: string
  botId: string
  botType: string
  traits: string[]
  ownerUserId: string
}

let config: Config | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let pollInFlightRunId: number | undefined
let pending: ClaimedInvocation | undefined
let steeredInvocations: Array<{ invocation: ClaimedInvocation; cursor?: string }> = []
let pendingContextCursor: string | undefined
let pendingAssistantTexts: string[] = []
let pendingNonAssistantTexts: Array<{ role: string; text: string }> = []
let pendingToolCalls = new Map<string, { headline: string }>()
let pendingProviderError: string | undefined
let pendingRetryAfterMs: number | undefined
let pendingInvocationPrompt: string | undefined
let pendingRetry: { timer: ReturnType<typeof setTimeout>; retryAt: number; attempts: number } | undefined
let isWaitingForRetry = false
let lastTraceHeartbeat: { text: string; at: number } | undefined
let consecutivePollFailures = 0
let lastPollFailureSummary: string | undefined
let lastBusyHeartbeatAt = 0
let lastPollDebugSummary: string | undefined
let pollingRunId = 0
let fallbackRuntimeSessionId: string | undefined

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
  return migrateSessionState(candidate as Config)
}

function readStoredConfig(): Partial<Config> | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<Config>) : undefined
  } catch (error) {
    console.error(`Failed to parse ${CONFIG_PATH}: ${String(error)}`)
    return undefined
  }
}

function migrateSessionState(candidate: Config): Config {
  if (!candidate.linkedSessions || typeof candidate.linkedSessions !== "object") return candidate
  for (const [sessionId, link] of Object.entries(candidate.linkedSessions)) {
    if (!link || typeof link !== "object") {
      delete candidate.linkedSessions[sessionId]
      continue
    }
    link.enabled ??= candidate.enabled ?? true
    if (!link.streamCursors && candidate.streamCursors) {
      const cursor = candidate.streamCursors[link.activeStreamId] ?? candidate.streamCursors[link.rootStreamId]
      if (cursor) link.streamCursors = { [link.activeStreamId]: cursor }
    }
  }
  return candidate
}

function readConfig(): Config | undefined {
  const stored = readStoredConfig()
  return stored ? validateConfig(stored) : undefined
}

function saveConfig(): void {
  if (!config) return
  const persisted: Config = { ...config }
  delete persisted.enabled
  delete persisted.streamCursors
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, `${JSON.stringify(persisted, null, 2)}\n`)
}

function ensureInstanceId(): string {
  if (!config) throw new Error("Threa remote config not loaded")
  if (config.instanceId) return config.instanceId
  config.instanceId = `pi-${hostname()}-${crypto.randomUUID().slice(0, 8)}`
  saveConfig()
  return config.instanceId
}

function getRuntimeSessionId(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager.getSessionId()
  if (sessionId) return sessionId
  fallbackRuntimeSessionId ??= `pi-session-${Date.now()}`
  return fallbackRuntimeSessionId
}

function getCurrentSessionLink(ctx: ExtensionContext): RuntimeSessionLink | undefined {
  if (!config?.linkedSessions) return undefined
  return config.linkedSessions[getRuntimeSessionId(ctx)]
}

function setCurrentSessionEnabled(ctx: ExtensionContext, enabled: boolean): RuntimeSessionLink | undefined {
  const link = getCurrentSessionLink(ctx)
  if (!link) return undefined
  link.enabled = enabled
  saveConfig()
  return link
}

function buildScratchpadUrl(baseUrl: string, streamUrlPath: string): string {
  return new URL(streamUrlPath, baseUrl).toString()
}

async function openExternalUrl(url: string): Promise<void> {
  const os = platform()
  if (os === "darwin") {
    try {
      await execFileAsync("open", ["-a", "Threa", url], { timeout: OPEN_URL_TIMEOUT_MS })
      return
    } catch {
      await execFileAsync("open", [url], { timeout: OPEN_URL_TIMEOUT_MS })
      return
    }
  }
  if (os === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url], { timeout: OPEN_URL_TIMEOUT_MS })
    return
  }
  await execFileAsync("xdg-open", [url], { timeout: OPEN_URL_TIMEOUT_MS })
}

function isCurrentSessionEnabled(ctx: ExtensionContext): boolean {
  return getCurrentSessionLink(ctx)?.enabled === true
}

function isPollDebugEnabled(ctx: ExtensionContext): boolean {
  return getCurrentSessionLink(ctx)?.debugPolling === true
}

function setPollDebug(ctx: ExtensionContext, enabled: boolean): boolean {
  const link = getCurrentSessionLink(ctx)
  if (!link) return false
  link.debugPolling = enabled
  saveConfig()
  return true
}

function emitPollDebug(ctx: ExtensionContext, summary: string): void {
  lastPollDebugSummary = `${new Date().toISOString()} ${summary}`
  if (!isPollDebugEnabled(ctx)) return
  ctx.ui.notify(`Threa remote poll: ${summary}`, "info")
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

function buildModelSuggestions(ctx: ExtensionContext): Array<{ value: string; label: string }> {
  const preferred = new Set((config?.preferredModels ?? []).map((value) => value.toLowerCase()))
  const ordered = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name }))
  ordered.sort((a, b) => {
    const aPref = preferred.has(a.value.toLowerCase())
    const bPref = preferred.has(b.value.toLowerCase())
    if (aPref !== bPref) return aPref ? -1 : 1
    return 0
  })
  return ordered.slice(0, 30)
}

function buildRuntimeCapabilities(ctx?: ExtensionContext): Record<string, unknown> {
  return {
    supportsActiveScratchpad: true,
    supportsPersistentSessions: true,
    supportsMentionInvocations: true,
    supportsSessionControlCommands: true,
    sessionControlCommands: [...SESSION_CONTROL_COMMANDS],
    thinkingLevels: [...THINKING_LEVELS],
    preferredModels: [...(config?.preferredModels ?? [])],
    ...(ctx?.model && { currentModel: `${ctx.model.provider}/${ctx.model.id}` }),
    ...(ctx && { modelSuggestions: buildModelSuggestions(ctx) }),
  }
}

async function heartbeat(
  status: "available" | "busy" | "offline" | "error",
  statusText?: string,
  ctx?: ExtensionContext
): Promise<void> {
  if (!config) return
  const runtimeSessionId = ctx ? getRuntimeSessionId(ctx) : undefined
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-runtime/presence`, {
    method: "POST",
    body: JSON.stringify({
      runtimeKind: "pi-local",
      instanceId: ensureInstanceId(),
      runtimeSessionId,
      displayName: config.defaultDisplayName,
      status,
      acceptingInvocations: status === "available",
      capabilities: buildRuntimeCapabilities(ctx),
      statusText,
    }),
  })
}

async function heartbeatBusyIfStale(statusText = "Working…", ctx?: ExtensionContext): Promise<boolean> {
  const now = Date.now()
  if (now - lastBusyHeartbeatAt < BUSY_HEARTBEAT_MS) return false
  lastBusyHeartbeatAt = now
  await heartbeat("busy", statusText, ctx)
  return true
}

function truncateForTrace(text: string, max = TRACE_CONTENT_MAX_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n\n…[trace content truncated; ${trimmed.length - max} more characters]`
}

async function recordInvocationTraceStep(
  invocation: ClaimedInvocation,
  stepType: string,
  content: string,
  statusText?: string
): Promise<void> {
  if (!config) return
  const trimmed = truncateForTrace(content)
  if (!trimmed) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/steps`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      stepType,
      content: trimmed,
      statusText: statusText?.trim().slice(0, 160),
    }),
  }).catch(() => undefined)
}

async function recordTraceStep(stepType: string, content: string, statusText?: string): Promise<void> {
  if (!pending) return
  await recordInvocationTraceStep(pending, stepType, content, statusText)
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
  const runtimeSessionId = getRuntimeSessionId(ctx)
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

  const existing = config.linkedSessions?.[runtimeSessionId]
  const legacyCursor =
    config.streamCursors?.[body.data.activeStreamId] ?? config.streamCursors?.[body.data.rootStreamId]
  config.linkedSessions ??= {}
  config.linkedSessions[runtimeSessionId] = {
    ...body.data,
    enabled: true,
    streamCursors: existing?.streamCursors ?? (legacyCursor ? { [body.data.activeStreamId]: legacyCursor } : undefined),
  }
  saveConfig()

  ctx.ui.notify(`Threa remote linked: ${body.data.streamUrlPath}`, "info")
  setRemoteStatus(ctx, `Threa remote: ${displayName}`)
  await heartbeat("available", undefined, ctx)
}

async function renewInvocationClaim(invocation: ClaimedInvocation): Promise<void> {
  if (!config) return
  const body = await request<{ data: { claimExpiresAt: string | null } }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/renew`,
    {
      method: "POST",
      body: JSON.stringify({
        instanceId: ensureInstanceId(),
        claimToken: invocation.claimToken,
        claimTtlSeconds: 120,
      }),
    }
  )
  invocation.claimExpiresAt = body.data.claimExpiresAt
}

async function renewActiveClaims(): Promise<void> {
  if (!pending) return
  await renewInvocationClaim(pending)
  await Promise.all(steeredInvocations.map((item) => renewInvocationClaim(item.invocation)))
}

function isEnabled(ctx: ExtensionContext): boolean {
  return isCurrentSessionEnabled(ctx)
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

function configTemplate(existing: Partial<Config> | undefined): string {
  return JSON.stringify(
    {
      baseUrl: existing?.baseUrl ?? "https://app.threa.io",
      workspaceId: existing?.workspaceId ?? "",
      apiKey: existing?.apiKey ?? "",
      pollMs: existing?.pollMs ?? 3000,
      defaultDisplayName: existing?.defaultDisplayName ?? "Local Pi",
      preferredModels: existing?.preferredModels ?? [],
    },
    null,
    2
  )
}

function parseConfigPatch(text: string): ConfigPatch {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object")
  }
  const candidate = parsed as Partial<ConfigPatch>
  for (const field of ["baseUrl", "workspaceId", "apiKey"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field].trim().length === 0) {
      throw new Error(`Missing required config field: ${field}`)
    }
  }
  if (candidate.pollMs !== undefined && (typeof candidate.pollMs !== "number" || !Number.isFinite(candidate.pollMs))) {
    throw new Error("pollMs must be a number")
  }
  if (candidate.defaultDisplayName !== undefined && typeof candidate.defaultDisplayName !== "string") {
    throw new Error("defaultDisplayName must be a string")
  }
  if (
    candidate.preferredModels !== undefined &&
    (!Array.isArray(candidate.preferredModels) || candidate.preferredModels.some((value) => typeof value !== "string"))
  ) {
    throw new Error("preferredModels must be an array of strings")
  }
  const { baseUrl, workspaceId, apiKey } = candidate as ConfigPatch
  return {
    baseUrl: baseUrl.trim(),
    workspaceId: workspaceId.trim(),
    apiKey: apiKey.trim(),
    pollMs: candidate.pollMs,
    defaultDisplayName: candidate.defaultDisplayName?.trim() || undefined,
    preferredModels: candidate.preferredModels?.map((value) => value.trim()).filter((value) => value.length > 0),
  }
}

async function configureRemote(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const existing = readStoredConfig()
  const input = args.trim() || (await ctx.ui.editor("Threa remote config", configTemplate(existing)))
  if (!input) return
  const patch = parseConfigPatch(input)
  const next = validateConfig({ ...existing, ...patch })
  if (!next) throw new Error(`Invalid ${CONFIG_PATH}`)
  config = next
  saveConfig()
  ctx.ui.notify(`Saved Threa remote config to ${CONFIG_PATH}`, "info")
}

async function fetchBotPrincipal(): Promise<BotPrincipal | null> {
  if (!config) return null
  const body = await request<{ data: BotPrincipal | { kind: string } }>(`/api/v1/workspaces/${config.workspaceId}/me`)
  return body.data.kind === "bot" ? (body.data as BotPrincipal) : null
}

function botTraitDiagnostics(principal: BotPrincipal | null): string[] {
  if (!principal) return ["bot=<not a bot key>"]
  const missing = ["active-scratchpad", "mentionable"].filter((trait) => !principal.traits.includes(trait))
  return [
    `bot=${principal.botId}`,
    `botTraits=${principal.traits.length > 0 ? principal.traits.join(",") : "<none>"}`,
    ...(missing.length > 0 ? [`missingTraits=${missing.join(",")}`] : []),
  ]
}

async function disableRemote(ctx: ExtensionContext): Promise<void> {
  if (!config) return
  const link = setCurrentSessionEnabled(ctx, false)
  stopPolling()
  await failPending("Threa remote disabled", ctx)
  await heartbeat("offline", undefined, ctx).catch(() => undefined)
  setRemoteStatus(ctx, "Threa remote: off")
  ctx.ui.notify(link ? "Threa remote disabled for this Pi session" : "No Threa remote session is linked here", "info")
}

async function enableRemote(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!config) return
  const link = setCurrentSessionEnabled(ctx, true)
  if (!link) {
    ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
    return
  }
  lastBusyHeartbeatAt = 0
  await heartbeat("available", undefined, ctx)
  startPolling(pi, ctx)
  ctx.ui.notify("Threa remote enabled for this Pi session", "info")
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
  cwd: string,
  sessionLink: RuntimeSessionLink | undefined
): Promise<{ context: string; cursor?: string }> {
  if (!config) return { context: "" }
  const cursor = sessionLink?.streamCursors?.[invocation.activeStreamId]
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

function buildClaimInvocationPayload(
  instanceId: string,
  runtimeSessionId: string,
  options?: { includeSessionControl?: boolean }
): Record<string, unknown> {
  const supportedCapabilities = ["active-scratchpad", "mentionable"]
  if (options?.includeSessionControl) supportedCapabilities.push(SESSION_CONTROL_CAPABILITY)
  return {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    supportedCapabilities,
    claimTtlSeconds: 120,
  }
}

function buildClaimInvocationBody(ctx: ExtensionContext): Record<string, unknown> {
  return buildClaimInvocationPayload(ensureInstanceId(), getRuntimeSessionId(ctx), {
    includeSessionControl: !pending && ctx.isIdle(),
  })
}

async function claimNextInvocation(ctx: ExtensionContext): Promise<ClaimedInvocation | null> {
  if (!config) return null
  const startedAt = Date.now()
  try {
    const body = await request<{ data: ClaimedInvocation | null }>(
      `/api/v1/workspaces/${config.workspaceId}/bot-invocations/claim`,
      {
        method: "POST",
        body: JSON.stringify(buildClaimInvocationBody(ctx)),
      }
    )
    emitPollDebug(
      ctx,
      body.data
        ? `claimed ${body.data.id} in ${Date.now() - startedAt}ms`
        : `no invocation in ${Date.now() - startedAt}ms`
    )
    return body.data
  } catch (error) {
    emitPollDebug(ctx, `failed after ${Date.now() - startedAt}ms: ${summarizeError(error)}`)
    throw error
  }
}

type RuntimeCommandMetadata = { id: string; name: string; args: string; executionKind: "bot-runtime" }

function getRuntimeCommand(invocation: ClaimedInvocation): RuntimeCommandMetadata | null {
  const command = invocation.metadata?.command
  if (!command || typeof command !== "object") return null
  const value = command as Record<string, unknown>
  if (value.executionKind !== "bot-runtime") return null
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.args !== "string") return null
  return { id: value.id, name: value.name, args: value.args, executionKind: "bot-runtime" }
}

function isSessionControlInvocation(invocation: ClaimedInvocation): boolean {
  return invocation.requiredCapability === SESSION_CONTROL_CAPABILITY || getRuntimeCommand(invocation) !== null
}

function normalizeThinkingLevel(input: string): ThinkingLevel | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (normalized === "none") return "off"
  if (normalized === "xhigh") return "xhigh"
  return THINKING_LEVELS.includes(normalized as ThinkingLevel) ? (normalized as ThinkingLevel) : null
}

async function completeInvocationWithMarkdown(
  invocation: ClaimedInvocation,
  finalMessageMarkdown: string,
  ctx?: ExtensionContext
): Promise<void> {
  if (!config) return
  await recordInvocationTraceStep(invocation, "response", finalMessageMarkdown, "Composing response…")
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      finalMessageMarkdown,
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": ensureInstanceId(),
        "pi.remote.sessionControl": "true",
      },
    }),
  })
  lastBusyHeartbeatAt = 0
  await heartbeat("available", undefined, ctx).catch(() => undefined)
}

async function buildInvocationPrompt(
  invocation: ClaimedInvocation,
  ctx: ExtensionContext
): Promise<{ prompt: string; cursor?: string; context: string }> {
  const { context, cursor } = await fetchInvocationContext(invocation, ctx.cwd, getCurrentSessionLink(ctx)).catch(
    (error): { context: string; cursor?: string } => {
      ctx.ui.notify(`Threa remote context fetch failed: ${summarizeError(error)}`, "warning")
      return { context: "" }
    }
  )
  return {
    context,
    cursor,
    prompt: [
      `Remote Threa invocation ${invocation.id}.`,
      `Source message: ${invocation.sourceMessageId}`,
      "Respond normally; the extension will post your final answer back to Threa.",
      "To attach a local file to your reply, add a line exactly like `THREA_ATTACH: path/to/file`; the extension will upload it and replace it with an attachment link.",
      context ? `\n${context}` : "",
      "\nSource message prompt:",
      invocation.promptMarkdown,
    ].join("\n"),
  }
}

function beginPendingInvocation(invocation: ClaimedInvocation, cursor?: string): void {
  pending = invocation
  pendingContextCursor = cursor
  pendingAssistantTexts = []
  pendingNonAssistantTexts = []
  pendingToolCalls = new Map()
  pendingProviderError = undefined
  pendingRetryAfterMs = undefined
  pendingInvocationPrompt = undefined
  clearPendingRetry()
  isWaitingForRetry = false
  lastTraceHeartbeat = undefined
}

function clearPendingRetry(): void {
  if (!pendingRetry) return
  clearTimeout(pendingRetry.timer)
  pendingRetry = undefined
}

function resetPendingTurnTexts(): void {
  pendingAssistantTexts = []
  pendingNonAssistantTexts = []
  pendingToolCalls = new Map()
  pendingProviderError = undefined
  pendingRetryAfterMs = undefined
  lastTraceHeartbeat = undefined
}

async function injectInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation,
  steer: boolean
): Promise<void> {
  const { prompt, cursor, context } = await buildInvocationPrompt(invocation, ctx)
  if (!pending) {
    beginPendingInvocation(invocation, cursor)
    pendingInvocationPrompt = prompt
    await recordTraceStep("context_received", formatInvocationTrace(invocation, context), "Loaded context…")
  } else {
    steeredInvocations.push({ invocation, cursor })
    await recordInvocationTraceStep(
      invocation,
      "context_received",
      formatInvocationTrace(invocation, context),
      "Loaded context…"
    )
  }
  setRemoteStatus(ctx, `Threa remote: running ${pending.id}`)
  pi.sendUserMessage(prompt, steer ? { deliverAs: "steer" } : undefined)
}

function compactSession(ctx: ExtensionContext, customInstructions?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      customInstructions: customInstructions?.trim() || undefined,
      onComplete: () => resolve(),
      onError: (error) => reject(error),
    })
  })
}

type ModelCandidate = { value: string; label: string; model: NonNullable<ExtensionContext["model"]> }

function getModelCandidates(ctx: ExtensionContext): ModelCandidate[] {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, model }))
}

function groupModelCandidates(
  ctx: ExtensionContext,
  preferred: readonly string[]
): { preferred: ModelCandidate[]; reasoning: ModelCandidate[]; standard: ModelCandidate[] } {
  const candidates = getModelCandidates(ctx)
  const preferredLower = new Set(preferred.map((value) => value.toLowerCase()))
  const preferredList: ModelCandidate[] = []
  const reasoning: ModelCandidate[] = []
  const standard: ModelCandidate[] = []
  for (const candidate of candidates) {
    if (preferredLower.has(candidate.value.toLowerCase())) {
      preferredList.push(candidate)
      continue
    }
    if (candidate.model.reasoning === true) {
      reasoning.push(candidate)
    } else {
      standard.push(candidate)
    }
  }
  return { preferred: preferredList, reasoning, standard }
}

function renderModelGroup(title: string, candidates: ModelCandidate[]): string[] {
  if (candidates.length === 0) return []
  return [`**${title}**`, ...candidates.map((candidate) => `- \`${candidate.value}\` — ${candidate.label}`)]
}

function renderGroupedModelList(ctx: ExtensionContext): string {
  const groups = groupModelCandidates(ctx, config?.preferredModels ?? [])
  const sections = [
    ...renderModelGroup("Preferred", groups.preferred),
    ...renderModelGroup("Reasoning", groups.reasoning),
    ...renderModelGroup("Standard", groups.standard),
  ]
  return sections.join("\n")
}

function resolveModelCandidate(
  ctx: ExtensionContext,
  query: string
): { match?: ModelCandidate; candidates?: ModelCandidate[] } {
  const normalized = query.trim().toLowerCase()
  const candidates = getModelCandidates(ctx)
  if (!normalized) return { candidates: candidates.slice(0, 10) }

  const exact = candidates.filter(
    (candidate) =>
      candidate.value.toLowerCase() === normalized ||
      candidate.model.id.toLowerCase() === normalized ||
      candidate.label.toLowerCase() === normalized
  )
  if (exact.length === 1) return { match: exact[0] }
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }

  const fuzzy = candidates.filter(
    (candidate) =>
      candidate.value.toLowerCase().includes(normalized) || candidate.label.toLowerCase().includes(normalized)
  )
  if (fuzzy.length === 1) return { match: fuzzy[0] }
  return { candidates: fuzzy.slice(0, 10) }
}

type PiCommand = ReturnType<ExtensionAPI["getCommands"]>[number]

function displaySkillName(command: PiCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name
}

function resolveSkillCommand(pi: ExtensionAPI, query: string): { match?: PiCommand; candidates: PiCommand[] } {
  const normalized = query.trim().toLowerCase()
  const skills = pi.getCommands().filter((command) => command.source === "skill")
  if (!normalized) return { candidates: skills.slice(0, 10) }

  const exact = skills.filter((command) => {
    const display = displaySkillName(command).toLowerCase()
    return command.name.toLowerCase() === normalized || display === normalized
  })
  if (exact.length === 1) return { match: exact[0], candidates: exact }
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }

  const fuzzy = skills.filter((command) => {
    const haystack = [command.name, displaySkillName(command), command.description ?? ""].join(" ").toLowerCase()
    return haystack.includes(normalized)
  })
  if (fuzzy.length === 1) return { match: fuzzy[0], candidates: fuzzy }
  return { candidates: fuzzy.slice(0, 10) }
}

async function runCompactCommand(invocation: ClaimedInvocation, args: string, ctx: ExtensionContext): Promise<void> {
  await recordInvocationTraceStep(invocation, "tool_call", "Compacting the linked Pi session…", "Compacting session…")
  await compactSession(ctx, args)
  await completeInvocationWithMarkdown(invocation, "Compacted the linked Pi session.", ctx)
}

async function runModelCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext
): Promise<void> {
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"
  const trimmed = args.trim()
  const resolved = resolveModelCandidate(ctx, args)
  if (!resolved.match) {
    // No args: show the full grouped catalog (Preferred / Reasoning / Standard).
    // Ambiguous match: show just the candidates so the user can pick.
    const body = trimmed
      ? [
          `No unique model match for \`${trimmed}\`.`,
          "Candidates:",
          ...(resolved.candidates ?? []).map((candidate) => `- \`${candidate.value}\` — ${candidate.label}`),
        ].join("\n")
      : `Current model: \`${current}\`.\n\n${renderGroupedModelList(ctx)}`
    await completeInvocationWithMarkdown(invocation, body, ctx)
    return
  }

  const ok = await pi.setModel(resolved.match.model)
  if (!ok) throw new Error(`No API key configured for ${resolved.match.value}`)
  await completeInvocationWithMarkdown(invocation, `Model changed: \`${current}\` → \`${resolved.match.value}\``, ctx)
}

async function runThinkingCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext
): Promise<void> {
  const level = normalizeThinkingLevel(args)
  if (!level) {
    await completeInvocationWithMarkdown(invocation, `Usage: \`/thinking ${THINKING_LEVELS.join("|")}\``, ctx)
    return
  }
  const before = pi.getThinkingLevel()
  pi.setThinkingLevel(level)
  const after = pi.getThinkingLevel()
  await completeInvocationWithMarkdown(invocation, `Thinking level changed: \`${before}\` → \`${after}\``, ctx)
}

async function runReloadCommand(invocation: ClaimedInvocation, ctx: ExtensionContext): Promise<void> {
  // Complete the invocation before reload — `await ctx.reload()` emits session_shutdown
  // for this runtime, so any acknowledgement after the await would run against a
  // pre-reload extension instance and may not survive.
  await completeInvocationWithMarkdown(invocation, "Reloading Pi extensions, skills, prompts, and themes…", ctx)
  await ctx.reload()
}

async function runSkillCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext
): Promise<void> {
  const resolved = resolveSkillCommand(pi, args)
  if (!resolved.match) {
    const lines = [
      args.trim() ? `No unique skill match for \`${args.trim()}\`.` : "Tell me which skill to run.",
      "Candidates:",
      ...resolved.candidates.map(
        (candidate) => `- \`/${candidate.name}\`${candidate.description ? ` — ${candidate.description}` : ""}`
      ),
    ]
    await completeInvocationWithMarkdown(invocation, lines.join("\n"), ctx)
    return
  }

  beginPendingInvocation(invocation)
  await recordInvocationTraceStep(
    invocation,
    "context_received",
    `Resolved /skill ${args} to /${resolved.match.name}`,
    "Resolved skill…"
  )
  setRemoteStatus(ctx, `Threa remote: running ${invocation.id}`)
  pi.sendUserMessage(`/${resolved.match.name}`)
}

async function handleSessionControlInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation
): Promise<void> {
  const command = getRuntimeCommand(invocation)
  if (!command) {
    await failInvocation(invocation, "Missing runtime command metadata")
    return
  }

  try {
    await heartbeat("busy", `Running /${command.name}…`, ctx)
    await recordInvocationTraceStep(
      invocation,
      "context_received",
      `Running /${command.name}${command.args ? ` ${command.args}` : ""}`,
      `Running /${command.name}…`
    )
    switch (command.name) {
      case "compact":
        await runCompactCommand(invocation, command.args, ctx)
        return
      case "model":
        await runModelCommand(pi, invocation, command.args, ctx)
        return
      case "thinking":
        await runThinkingCommand(pi, invocation, command.args, ctx)
        return
      case "skill":
        await runSkillCommand(pi, invocation, command.args, ctx)
        return
      case "reload":
        await runReloadCommand(invocation, ctx)
        return
      default:
        await failInvocation(invocation, `Unsupported session-control command: ${command.name}`)
    }
  } catch (error) {
    await failInvocation(invocation, error)
    lastBusyHeartbeatAt = 0
    await heartbeat("available", undefined, ctx).catch(() => undefined)
  }
}

async function scheduleProviderRetry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  retryAfterMs: number,
  attempt: number
): Promise<void> {
  if (!pending) return
  const retryAt = Date.now() + retryAfterMs
  const notice = formatRetryNotice(retryAfterMs, attempt)
  await recordTraceStep("rate_limited", notice, "Rate limited; waiting…").catch(() => undefined)
  setRemoteStatus(ctx, `Threa remote: retry ${formatLocalTime(new Date(retryAt))}`)
  lastBusyHeartbeatAt = 0
  await heartbeat("busy", notice.slice(0, 160), ctx).catch(() => undefined)
  isWaitingForRetry = true
  pendingRetry = {
    timer: setTimeout(() => {
      void executeProviderRetry(pi, ctx, attempt)
    }, retryAfterMs),
    retryAt,
    attempts: attempt,
  }
}

async function executeProviderRetry(pi: ExtensionAPI, ctx: ExtensionContext, attempt: number): Promise<void> {
  pendingRetry = undefined
  const invocation = pending
  const prompt = pendingInvocationPrompt
  if (!invocation) {
    isWaitingForRetry = false
    return
  }
  if (!prompt) {
    // No prompt is recorded for the active turn (e.g. /skill, which calls beginPendingInvocation and
    // then hands off to pi.sendUserMessage("/<skill>")). We can't auto-retry without the original
    // prompt, so surface the rate limit as a failure instead of silently holding the claim open.
    isWaitingForRetry = false
    await failPending(pendingProviderError ?? "Rate limited and unable to auto-retry this command.", ctx)
    return
  }
  resetPendingTurnTexts()
  isWaitingForRetry = false
  await recordTraceStep(
    "rate_limit_retry",
    `Retrying after rate limit (attempt ${attempt} of ${MAX_RETRY_ATTEMPTS}).`,
    "Retrying…"
  ).catch(() => undefined)
  setRemoteStatus(ctx, `Threa remote: running ${invocation.id}`)
  lastBusyHeartbeatAt = 0
  await heartbeat("busy", "Retrying after rate limit…", ctx).catch(() => undefined)
  pi.sendUserMessage(prompt)
}

async function claimIfIdle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  if (!config || !isEnabled(ctx)) return false
  if (pending) await renewActiveClaims()

  if (isWaitingForRetry) {
    const retryAt = pendingRetry ? formatLocalTime(new Date(pendingRetry.retryAt)) : "soon"
    await heartbeatBusyIfStale(`Rate limited; retrying around ${retryAt}`, ctx)
    return true
  }

  const steer = pending !== undefined || !ctx.isIdle()
  if (steer) await heartbeatBusyIfStale(pending ? "Working on Threa invocation…" : "Busy in Pi…", ctx)

  const invocation = await claimNextInvocation(ctx)
  if (!invocation) return true
  if (isSessionControlInvocation(invocation)) {
    await handleSessionControlInvocation(pi, ctx, invocation)
    return true
  }
  await injectInvocation(pi, ctx, invocation, steer)
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

function captureMessageText(message: unknown): { role: string; text: string } | null {
  if (!message || typeof message !== "object" || !("role" in message) || !("content" in message)) return null
  const role = String((message as { role: unknown }).role)
  // Skip user (our injected prompt echoed back) and tool (covered by tool_call/tool_result events).
  if (role === "user" || role === "tool") return null
  const text = textFromContent((message as { content: unknown }).content).trim()
  return text ? { role, text } : null
}

function textFromAgentMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "Done."
  const captured = messages
    .map(captureMessageText)
    .filter((item): item is { role: string; text: string } => item !== null)
  if (captured.length === 0) return "Done."
  const assistant = captured
    .filter((item) => item.role === "assistant")
    .map((item) => item.text)
    .join("\n\n")
    .trim()
  if (assistant) return assistant
  return (
    captured
      .map((item) => item.text)
      .join("\n\n")
      .trim() || "Done."
  )
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== target) continue
    if (typeof value === "string") return value
    if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  }
  return undefined
}

function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  const raw = readHeader(headers, "retry-after")?.trim()
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined
  }
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(0, parsed - now)
}

function formatLocalTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return "<1 min"
  if (totalMin < 60) return `${totalMin} min`
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

function describeProviderError(status: number, headers: unknown, now: number = Date.now()): string {
  const retryAfterMs = parseRetryAfter(headers, now)
  if (status === 429) {
    if (retryAfterMs === undefined) return "Error: model provider rate-limited the request (HTTP 429)."
    const retryAt = new Date(now + retryAfterMs)
    return `Error: model provider rate-limited the request (HTTP 429). Try again around ${formatLocalTime(retryAt)} (in ~${formatDuration(retryAfterMs)}).`
  }
  if (status === 401 || status === 403) return `Error: model provider denied the request (HTTP ${status}).`
  if (status >= 500) return `Error: model provider returned a server error (HTTP ${status}).`
  return `Error: model provider returned HTTP ${status}.`
}

function formatRetryNotice(retryAfterMs: number, attempt: number, now: number = Date.now()): string {
  const retryAt = new Date(now + retryAfterMs)
  const attemptNote = attempt > 1 ? ` (attempt ${attempt} of ${MAX_RETRY_ATTEMPTS})` : ""
  return `Rate limited by model provider. Will retry around ${formatLocalTime(retryAt)} (in ~${formatDuration(retryAfterMs)})${attemptNote}.`
}

function extractAgentEndError(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const error = (event as { error?: unknown }).error
  if (typeof error === "string") {
    const trimmed = error.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") {
      const trimmed = message.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
  }
  return undefined
}

function resolveFinalText(
  event: unknown,
  state: {
    assistantTexts: string[]
    otherTexts: Array<{ role: string; text: string }>
    providerError?: string
  }
): string {
  if (state.assistantTexts.length > 0) return state.assistantTexts.join("\n\n")
  if (state.providerError) return state.providerError
  const eventError = extractAgentEndError(event)
  if (eventError) return eventError
  if (state.otherTexts.length > 0) return state.otherTexts.map((item) => item.text).join("\n\n")
  return textFromAgentMessages((event as { messages?: unknown } | undefined)?.messages)
}

function startPolling(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!isEnabled(ctx)) return
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

function advanceStreamCursor(invocation: ClaimedInvocation, ctx: ExtensionContext, cursor?: string): void {
  if (!config || !cursor) return
  const link = getCurrentSessionLink(ctx)
  if (!link) return
  link.streamCursors ??= {}
  link.streamCursors[invocation.activeStreamId] = cursor
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

async function completeInvocationNoResponse(invocation: ClaimedInvocation): Promise<void> {
  if (!config) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      noResponse: true,
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": ensureInstanceId(),
        "pi.remote.noResponse": "true",
        "pi.remote.steered": "true",
      },
    }),
  }).catch(() => undefined)
}

async function failInvocation(invocation: ClaimedInvocation, error: unknown): Promise<void> {
  if (!config) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/fail`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      errorMessage: String(error).slice(0, 1000),
    }),
  }).catch(() => undefined)
}

async function completePending(markdown: string, ctx: ExtensionContext): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  const steered = steeredInvocations
  const { finalMarkdown, uploadedAttachments } = await prepareFinalMarkdown(markdown, ctx.cwd)
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
  await Promise.all(steered.map((item) => completeInvocationNoResponse(item.invocation)))
  advanceStreamCursor(invocation, ctx, pendingContextCursor)
  for (const item of steered) advanceStreamCursor(item.invocation, ctx, item.cursor)
  pending = undefined
  steeredInvocations = []
  pendingContextCursor = undefined
  pendingAssistantTexts = []
  pendingNonAssistantTexts = []
  pendingToolCalls = new Map()
  pendingProviderError = undefined
  pendingRetryAfterMs = undefined
  pendingInvocationPrompt = undefined
  clearPendingRetry()
  isWaitingForRetry = false
  lastTraceHeartbeat = undefined
  lastBusyHeartbeatAt = 0
  await heartbeat("available", undefined, ctx)
}

async function failPending(error: unknown, ctx?: ExtensionContext): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  const steered = steeredInvocations
  await failInvocation(invocation, error)
  await Promise.all(steered.map((item) => failInvocation(item.invocation, error)))
  pending = undefined
  steeredInvocations = []
  pendingContextCursor = undefined
  pendingAssistantTexts = []
  pendingNonAssistantTexts = []
  pendingToolCalls = new Map()
  pendingProviderError = undefined
  pendingRetryAfterMs = undefined
  pendingInvocationPrompt = undefined
  clearPendingRetry()
  isWaitingForRetry = false
  lastTraceHeartbeat = undefined
  lastBusyHeartbeatAt = 0
  await heartbeat("available", undefined, ctx).catch(() => undefined)
}

export const __testing = {
  describeToolCall,
  formatToolCallTrace,
  formatToolResultTrace,
  buildClaimInvocationPayload,
  buildRuntimeCapabilities,
  getRuntimeCommand,
  normalizeThinkingLevel,
  migrateSessionState,
  buildScratchpadUrl,
  parseConfigPatch,
  safeStatusText,
  captureMessageText,
  textFromAgentMessages,
  extractAgentEndError,
  resolveFinalText,
  parseRetryAfter,
  describeProviderError,
  formatRetryNotice,
  formatDuration,
  formatLocalTime,
  MAX_AUTO_RETRY_MS,
  MAX_RETRY_ATTEMPTS,
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("remote-control", {
    description: "Create or link a Threa scratchpad to this Pi session",
    handler: async (args, ctx) => {
      const trimmedArgs = args.trim()
      const commandMatch = trimmedArgs.match(/^(\S+)(?:\s+([\s\S]*))?$/)
      const command = commandMatch?.[1]?.toLowerCase() ?? ""
      const commandArgs = commandMatch?.[2] ?? ""
      if (command === "configure" || command === "config") {
        await configureRemote(ctx, commandArgs)
        return
      }

      config = readConfig()
      if (!config) {
        ctx.ui.notify(`Missing ${CONFIG_PATH}. Run /remote-control configure to paste setup JSON.`, "warning")
        return
      }
      if (command === "off" || command === "disable") {
        await disableRemote(ctx)
        return
      }
      if (command === "on" || command === "enable") {
        await enableRemote(pi, ctx)
        return
      }
      if (command === "open") {
        const link = getCurrentSessionLink(ctx)
        if (!link) {
          ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
          return
        }
        const url = buildScratchpadUrl(config.baseUrl, link.streamUrlPath)
        try {
          await openExternalUrl(url)
          ctx.ui.notify(`Opening Threa scratchpad: ${url}`, "info")
        } catch (error) {
          ctx.ui.notify(`Could not open Threa scratchpad: ${String(error)}\n${url}`, "error")
        }
        return
      }
      if (command === "debug-polls") {
        const enabled = commandArgs.trim().toLowerCase() !== "off"
        if (!setPollDebug(ctx, enabled)) {
          ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
          return
        }
        ctx.ui.notify(`Threa remote poll debug ${enabled ? "enabled" : "disabled"} for this Pi session`, "info")
        return
      }
      if (command === "status" || command === "debug") {
        const link = getCurrentSessionLink(ctx)
        const state = link?.enabled === true ? "on" : "off"
        const linked = link ? `linked to ${link.streamUrlPath}` : "not linked"
        const principal = command === "debug" ? await fetchBotPrincipal().catch(() => null) : null
        const details =
          command === "debug" && config
            ? [
                `session=${getRuntimeSessionId(ctx)}`,
                `instance=${config.instanceId ?? "<unset>"}`,
                `workspace=${config.workspaceId}`,
                `stream=${link?.activeStreamId ?? "<none>"}`,
                ...botTraitDiagnostics(principal),
                `debugPolling=${link?.debugPolling === true ? "on" : "off"}`,
                `pending=${pending?.id ?? "<none>"}`,
                `steered=${steeredInvocations.length}`,
                `lastPoll=${lastPollDebugSummary ?? "<none>"}`,
                `lastFailure=${lastPollFailureSummary ?? "<none>"}`,
              ].join("\n")
            : ""
        ctx.ui.notify(
          `Threa remote is ${state} for this Pi session (${linked})${pending ? `; running ${pending.id}` : ""}${
            details ? `\n${details}` : ""
          }`,
          "info"
        )
        return
      }
      await createRemoteSession(ctx, trimmedArgs)
      startPolling(pi, ctx)
    },
  })

  pi.on("session_start", async (event, ctx) => {
    config = readConfig()
    if (!config) return
    if (!isEnabled(ctx)) {
      setRemoteStatus(ctx, getCurrentSessionLink(ctx) ? "Threa remote: off" : "Threa remote: not linked")
      return
    }
    lastBusyHeartbeatAt = 0
    await heartbeat("available", undefined, ctx)
    startPolling(pi, ctx)
    if (event.reason === "reload") ctx.ui.notify("Threa remote reconnected after reload.", "info")
  })

  pi.on("agent_start", async (_event, ctx) => {
    if (config && isEnabled(ctx)) await heartbeatBusyIfStale("Thinking…", ctx).catch(() => undefined)
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
    const captured = captureMessageText(event.message)
    if (!captured) return
    if (captured.role === "assistant") pendingAssistantTexts.push(captured.text)
    else pendingNonAssistantTexts.push(captured)
  })

  pi.on("after_provider_response", async (event) => {
    if (!pending) return
    const raw = event as { status?: unknown; headers?: unknown }
    const status = typeof raw.status === "number" ? raw.status : 0
    if (status < 400) return
    pendingProviderError = describeProviderError(status, raw.headers)
    const retryAfterMs = parseRetryAfter(raw.headers)
    pendingRetryAfterMs =
      status === 429 && retryAfterMs !== undefined && retryAfterMs <= MAX_AUTO_RETRY_MS ? retryAfterMs : undefined
  })

  pi.on("agent_end", async (event, ctx) => {
    if (!pending) {
      if (config && isEnabled(ctx)) {
        lastBusyHeartbeatAt = 0
        await heartbeat("available", undefined, ctx).catch(() => undefined)
      }
      return
    }
    if (isWaitingForRetry) return
    if (pendingRetryAfterMs !== undefined && pendingAssistantTexts.length === 0) {
      const attempt = (pendingRetry?.attempts ?? 0) + 1
      if (attempt <= MAX_RETRY_ATTEMPTS) {
        await scheduleProviderRetry(pi, ctx, pendingRetryAfterMs, attempt)
        return
      }
    }
    try {
      const finalText = resolveFinalText(event, {
        assistantTexts: pendingAssistantTexts,
        otherTexts: pendingNonAssistantTexts,
        providerError: pendingProviderError,
      })
      const traceFinalText = extractAttachmentDirectives(finalText).markdown || NO_RESPONSE_MARKER
      await recordTraceStep("message_sent", `Final response:\n\n${sanitizeTraceText(traceFinalText)}`, "Sent response")
      await completePending(finalText, ctx)
      setRemoteStatus(ctx, "Threa remote: linked")
    } catch (error) {
      ctx.ui.notify(`Failed to complete Threa invocation: ${String(error)}`, "warning")
      await failPending(error, ctx)
    }
  })

  pi.on("session_shutdown", async (event, ctx) => {
    stopPolling()
    if (event.reason === "reload" && config && isEnabled(ctx)) {
      setRemoteStatus(ctx, "Threa remote: reloading…")
      return
    }
    await failPending("Pi session shut down", ctx)
    await heartbeat("offline", undefined, ctx).catch(() => undefined)
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
