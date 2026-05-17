import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = join(homedir(), ".pi", "agent", "threa-remote.json")
const STATUS_KEY = "threa-remote"

type Config = {
  baseUrl: string
  workspaceId: string
  apiKey: string
  pollMs?: number
  instanceId?: string
  defaultDisplayName?: string
  enabled?: boolean
  linkedSessions?: Record<string, RuntimeSessionLink>
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
  sourceMessageId: string
  promptMarkdown: string
  claimToken: string
  claimExpiresAt: string | null
}

let config: Config | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pending: ClaimedInvocation | undefined
let pendingAssistantTexts: string[] = []

function readConfig(): Config | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config
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
        supportsMentionInvocations: false,
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
  ctx.ui.setStatus(STATUS_KEY, `Threa remote: ${displayName}`)
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
}

async function disableRemote(ctx: ExtensionContext): Promise<void> {
  if (!config) return
  config.enabled = false
  saveConfig()
  stopPolling()
  pending = undefined
  pendingAssistantTexts = []
  await heartbeat("offline").catch(() => undefined)
  ctx.ui.setStatus(STATUS_KEY, "Threa remote: off")
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
        supportedCapabilities: ["active-scratchpad"],
        claimTtlSeconds: 120,
      }),
    }
  )

  if (!body.data) return
  pending = body.data
  pendingAssistantTexts = []
  await heartbeat("busy", `Working on ${body.data.id}`)
  ctx.ui.setStatus(STATUS_KEY, `Threa remote: running ${body.data.id}`)
  pi.sendUserMessage(
    [
      `Remote Threa invocation ${body.data.id}.`,
      `Source message: ${body.data.sourceMessageId}`,
      "Respond normally; the extension will post your final answer back to Threa.",
      "",
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
  const poll = () =>
    claimIfIdle(pi, ctx).catch((error) => ctx.ui.notify(`Threa remote poll failed: ${String(error)}`, "warning"))
  timer = setInterval(poll, Math.max(1000, config?.pollMs ?? 3000))
  setTimeout(poll, 0)
}

async function completePending(markdown: string): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: ensureInstanceId(),
      claimToken: invocation.claimToken,
      finalMessageMarkdown: markdown || "Done.",
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": ensureInstanceId(),
      },
    }),
  })
  pending = undefined
  pendingAssistantTexts = []
  await heartbeat("available")
}

async function failPending(error: unknown): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  pending = undefined
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
      ctx.ui.setStatus(STATUS_KEY, "Threa remote: off")
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
      ctx.ui.setStatus(STATUS_KEY, "Threa remote: linked")
    } catch (error) {
      ctx.ui.notify(`Failed to complete Threa invocation: ${String(error)}`, "warning")
      await failPending(error)
    }
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPolling()
    await heartbeat("offline").catch(() => undefined)
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
