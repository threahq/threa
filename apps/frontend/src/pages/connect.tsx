import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Bot, Check, Hourglass, SearchX, type LucideIcon } from "lucide-react"
import { BotTraits, WORKSPACE_PERMISSION_SCOPES, type Workspace } from "@threa/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ThreaLogo } from "@/components/threa-logo"
import { ApiError } from "@/api/client"
import { botConnectApi, type BotConnectLookup } from "@/api/bot-connect"
import { botsApi } from "@/api/bots"
import { useAuth } from "@/auth"
import { useWorkspaces } from "@/hooks"

/** What `threa-bot run` needs: presence, claims, replies, reading the stream, files both ways. */
export const CONNECTED_BOT_SCOPES = [
  WORKSPACE_PERMISSION_SCOPES.BOT_RUNTIME_WRITE,
  WORKSPACE_PERMISSION_SCOPES.BOT_INVOCATIONS_WRITE,
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_WRITE,
  WORKSPACE_PERMISSION_SCOPES.MESSAGES_READ,
  WORKSPACE_PERMISSION_SCOPES.STREAMS_READ,
  WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_READ,
  WORKSPACE_PERMISSION_SCOPES.ATTACHMENTS_WRITE,
]

export function normalizeCode(raw: string): string {
  const compact = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8)
  return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact
}

export function slugForBot(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
}

/**
 * Create the bot and mint its key in the workspace's region, then hand the
 * key to the control plane for the waiting device. A slug collision retries
 * once with a random suffix; anything else surfaces as the mutation error.
 */
export async function approveConnect(input: {
  code: string
  workspace: Workspace
  botName: string
}): Promise<{ slug: string }> {
  const baseSlug = slugForBot(input.botName) || "bot"
  const create = (slug: string) =>
    botsApi.create(input.workspace.id, {
      type: "personal",
      name: input.botName,
      slug,
      traits: [BotTraits.MENTIONABLE, BotTraits.ACTIVE_SCRATCHPAD],
    })
  let bot
  try {
    bot = await create(baseSlug)
  } catch (error) {
    if (!(ApiError.isApiError(error) && error.code === "DUPLICATE_SLUG")) throw error
    bot = await create(`${baseSlug}-${Math.random().toString(36).slice(2, 6)}`)
  }
  const key = await botsApi.createKey(input.workspace.id, bot.id, {
    name: "threa-bot connect",
    scopes: CONNECTED_BOT_SCOPES,
  })
  await botConnectApi.approve({
    code: input.code,
    workspaceId: input.workspace.id,
    workspaceName: input.workspace.name,
    botId: bot.id,
    botSlug: bot.slug ?? baseSlug,
    apiKey: key.value,
  })
  return { slug: bot.slug ?? baseSlug }
}

function Shell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,hsl(var(--primary)/0.10),transparent_55%)]"
      />
      <div className="relative flex w-full max-w-md flex-col items-center gap-10 p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <ThreaLogo size="lg" />
        {children}
      </div>
    </div>
  )
}

function HaloIcon({ icon: Icon, tone = "muted" }: { icon: LucideIcon; tone?: "primary" | "muted" }) {
  const haloClass = tone === "primary" ? "bg-primary/15" : "bg-muted/60"
  const iconClass = tone === "primary" ? "text-primary" : "text-muted-foreground"
  return (
    <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
      <div aria-hidden className={`absolute inset-1 rounded-full ${haloClass} blur-xl`} />
      <div className="relative flex h-14 w-14 items-center justify-center rounded-full border bg-background">
        <Icon className={`h-6 w-6 ${iconClass}`} />
      </div>
    </div>
  )
}

function CodeForm({ initial, onSubmit }: { initial: string; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState(initial)
  const complete = code.replace("-", "").length === 8
  return (
    <form
      className="w-full space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (complete) onSubmit(code)
      }}
    >
      <div className="space-y-2">
        <Label
          htmlFor="connect-code"
          className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
        >
          Code from your terminal
        </Label>
        <Input
          id="connect-code"
          value={code}
          onChange={(e) => setCode(normalizeCode(e.target.value))}
          placeholder="BCDF-GHJK"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="h-11 font-mono text-lg tracking-[0.2em]"
        />
      </div>
      <Button
        type="submit"
        className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
        disabled={!complete}
      >
        Continue
      </Button>
    </form>
  )
}

function ApproveForm({
  code,
  lookup,
  workspaces,
  onDone,
}: {
  code: string
  lookup: BotConnectLookup
  workspaces: Workspace[]
  onDone: (result: { slug: string; workspaceName: string } | "denied") => void
}) {
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "")
  const [botName, setBotName] = useState(lookup.requestedName ?? "My agent")
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const approve = useMutation({
    mutationFn: () => approveConnect({ code, workspace: workspace!, botName: botName.trim() }),
    onSuccess: ({ slug }) => onDone({ slug, workspaceName: workspace!.name }),
  })
  const deny = useMutation({
    mutationFn: () => botConnectApi.deny(code),
    onSuccess: () => onDone("denied"),
  })
  const busy = approve.isPending || deny.isPending
  const error = approve.error ?? deny.error
  return (
    <div className="w-full space-y-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <HaloIcon icon={Bot} tone="primary" />
        <h1 className="text-2xl font-medium leading-tight">
          Connect <span className="text-primary">{lookup.requestedName ?? "a bot runtime"}</span>
          {lookup.requestedHost ? ` from ${lookup.requestedHost}` : ""}
        </h1>
        <p className="font-mono text-sm tracking-[0.2em] text-muted-foreground">{lookup.userCode}</p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (workspace && botName.trim()) approve.mutate()
        }}
      >
        <div className="space-y-2">
          <Label
            htmlFor="connect-workspace"
            className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
          >
            Workspace
          </Label>
          <Select value={workspaceId} onValueChange={setWorkspaceId} disabled={busy}>
            <SelectTrigger id="connect-workspace" className="h-11">
              <SelectValue placeholder="Choose a workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label
            htmlFor="connect-bot-name"
            className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
          >
            Bot name
          </Label>
          <Input
            id="connect-bot-name"
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            disabled={busy}
            maxLength={60}
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">
            A personal bot you can @mention, with its own scratchpad. Its key is created now and sent to the machine
            that asked.
          </p>
        </div>
        {error && (
          <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Could not connect"}</p>
        )}
        <Button
          type="submit"
          className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
          disabled={busy || !workspace || !botName.trim()}
        >
          {approve.isPending ? "Connecting…" : "Connect"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full text-xs"
          disabled={busy}
          onClick={() => deny.mutate()}
        >
          Not me, deny
        </Button>
      </form>
    </div>
  )
}

export function ConnectPage() {
  const [params, setParams] = useSearchParams()
  const { user, loading: authLoading, login } = useAuth()
  const { workspaces, isLoading: workspacesLoading } = useWorkspaces()
  const code = normalizeCode(params.get("code") ?? "")
  const [done, setDone] = useState<{ slug: string; workspaceName: string } | "denied" | null>(null)

  const lookup = useQuery({
    queryKey: ["bot-connect-lookup", code],
    queryFn: () => botConnectApi.lookup(code),
    enabled: !!user && code.length === 9,
    retry: false,
  })

  if (authLoading) return <Shell />

  if (!user) {
    return (
      <Shell>
        <div className="flex w-full flex-col items-center gap-6 text-center">
          <HaloIcon icon={Bot} tone="primary" />
          <h1 className="text-2xl font-medium leading-tight">Sign in to connect a bot</h1>
          <Button
            className="h-11 w-full text-xs font-medium uppercase tracking-[0.14em]"
            onClick={() => login(`/connect${code ? `?code=${code}` : ""}`)}
          >
            Sign in
          </Button>
        </div>
      </Shell>
    )
  }

  if (done === "denied") {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 text-center">
          <HaloIcon icon={SearchX} />
          <h1 className="text-2xl font-medium leading-tight">Request denied</h1>
          <p className="text-sm text-muted-foreground">The terminal that asked will see it was turned down.</p>
        </div>
      </Shell>
    )
  }

  if (done) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 text-center">
          <HaloIcon icon={Check} tone="primary" />
          <h1 className="text-2xl font-medium leading-tight">
            <span className="text-primary">@{done.slug}</span> is connected to {done.workspaceName}
          </h1>
          <p className="text-sm text-muted-foreground">
            You can close this tab. The terminal has its key and is ready to run.
          </p>
          <Link to="/" className="text-sm text-foreground underline-offset-4 hover:underline">
            Open Threa
          </Link>
        </div>
      </Shell>
    )
  }

  if (code.length !== 9) {
    return (
      <Shell>
        <div className="w-full space-y-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <HaloIcon icon={Bot} tone="primary" />
            <h1 className="text-2xl font-medium leading-tight">Connect a bot runtime</h1>
          </div>
          <CodeForm initial={code} onSubmit={(next) => setParams({ code: next })} />
        </div>
      </Shell>
    )
  }

  if (lookup.isLoading || workspacesLoading) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Looking up {code}…</p>
      </Shell>
    )
  }

  if (lookup.isError || !lookup.data) {
    return (
      <Shell>
        <div className="flex w-full flex-col items-center gap-4 text-center">
          <HaloIcon icon={Hourglass} />
          <h1 className="text-2xl font-medium leading-tight">No pending request for {code}</h1>
          <p className="text-sm text-muted-foreground">
            Codes last 15 minutes and work once. Run <code>threa-bot connect</code> again for a fresh one.
          </p>
          <CodeForm initial="" onSubmit={(next) => setParams({ code: next })} />
        </div>
      </Shell>
    )
  }

  const list = workspaces ?? []
  if (list.length === 0) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-4 text-center">
          <HaloIcon icon={SearchX} />
          <h1 className="text-2xl font-medium leading-tight">You need a workspace first</h1>
          <Link to="/workspaces" className="text-sm text-foreground underline-offset-4 hover:underline">
            Create or join one
          </Link>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <ApproveForm code={code} lookup={lookup.data} workspaces={list} onDone={setDone} />
    </Shell>
  )
}
