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
}

let config: Config | undefined
let timer: ReturnType<typeof setInterval> | undefined
let pending: ClaimedInvocation | undefined

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

async function claimIfIdle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!config || pending || !ctx.isIdle()) return
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

function textFromAgentMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "Done."
  const text = messages
    .map((message) => {
      if (typeof message === "string") return message
      if (message && typeof message === "object" && "content" in message) return textFromContent(message.content)
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || "Done."
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
  await heartbeat("available")
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
      await createRemoteSession(ctx, args)
      await claimIfIdle(pi, ctx)
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    config = readConfig()
    if (!config) return
    await heartbeat("available")
    timer = setInterval(() => void claimIfIdle(pi, ctx), Math.max(1000, config.pollMs ?? 3000))
  })

  pi.on("agent_end", async (event, ctx) => {
    if (!pending) return
    try {
      await completePending(textFromAgentMessages(event.messages))
      ctx.ui.setStatus(STATUS_KEY, "Threa remote: linked")
    } catch (error) {
      ctx.ui.notify(`Failed to complete Threa invocation: ${String(error)}`, "warning")
      await heartbeat("error", String(error)).catch(() => undefined)
    }
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer)
    timer = undefined
    await heartbeat("offline").catch(() => undefined)
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
