import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"

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

interface StreamMessage {
  id: string
  authorType: string
  authorDisplayName?: string
  sequence: string
  content: string
  createdAt: string
}

let config: Config | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pollInFlight = false
let pending: ClaimedInvocation | undefined
let pendingContextCursor: string | undefined
let pendingAssistantTexts: string[] = []

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
  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
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

function formatInvocationContext(messages: StreamMessage[], sourceMessageId: string): string {
  if (messages.length === 0) return ""
  const orderedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return [
    "Recent Threa stream context (oldest first):",
    ...orderedMessages.map((message) => {
      const author = message.authorDisplayName || message.authorType
      const marker = message.id === sourceMessageId ? " [source]" : ""
      return `- ${author}${marker}: ${message.content}`
    }),
  ].join("\n")
}

async function fetchInvocationContext(invocation: ClaimedInvocation): Promise<{ context: string; cursor?: string }> {
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

  return {
    context: formatInvocationContext(orderedMessages, invocation.sourceMessageId),
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
  const { context, cursor } = await fetchInvocationContext(body.data).catch((error) => {
    ctx.ui.notify(`Threa remote context fetch failed: ${String(error)}`, "warning")
    return { context: "" }
  })
  pendingContextCursor = cursor
  await heartbeat("busy", `Working on ${body.data.id}`)
  setRemoteStatus(ctx, `Threa remote: running ${body.data.id}`)
  pi.sendUserMessage(
    [
      `Remote Threa invocation ${body.data.id}.`,
      `Source message: ${body.data.sourceMessageId}`,
      "Respond normally; the extension will post your final answer back to Threa.",
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

async function completePending(markdown: string): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  const finalMarkdown = markdown.trim() || "Done."
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
      },
    }),
  })
  advanceStreamCursor(invocation)
  pending = undefined
  pendingContextCursor = undefined
  pendingAssistantTexts = []
  await heartbeat("available")
}

async function failPending(error: unknown): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  pending = undefined
  pendingContextCursor = undefined
  pendingAssistantTexts = []
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
        pendingAssistantTexts.length > 0 ? pendingAssistantTexts.join("\n\n") : textFromAgentMessages(event.messages)
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
