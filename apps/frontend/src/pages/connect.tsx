import { useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Bot, Check, Hourglass, SearchX, type LucideIcon } from "lucide-react"
import { BotTraits, WORKSPACE_PERMISSION_SCOPES, type Workspace } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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

/** The regional writes approval depends on; kept across a failed approval so a retry does not mint again. */
export interface ProvisionedBot {
  workspaceId: string
  botId: string
  botSlug: string
  keyId: string
  apiKey: string
  readsAsOwner: boolean
}

/** The code cannot be approved any more; the bot and key minted for it were removed. */
export class ConnectCodeGoneError extends Error {
  constructor() {
    super(
      "This code is no longer valid (expired, denied, or already used). The bot created for it was removed; run `threa-bot connect` again."
    )
  }
}

/** The code is gone but the bot could not be archived; the identifiers are kept so the user can try again. */
export class ConnectCleanupFailedError extends Error {
  constructor(botSlug: string) {
    super(
      `This code is no longer valid, and removing the bot @${botSlug} failed. Try again, or archive it under workspace settings.`
    )
  }
}

export interface ApproveConnectInput {
  /** Normalized device-grant user code (`BCDF-GHJK`). */
  code: string
  workspace: Workspace
  botName: string
  /** Mint the bot with `readsAsOwner`; omitted means `false`. */
  readsAsOwner?: boolean
  /** A prior attempt's mint, reused so a retry does not create a second bot. */
  provisioned?: ProvisionedBot
  onProvisioned?: (provisioned: ProvisionedBot) => void
}

/**
 * Create the bot and mint its key in the workspace's region, then hand the
 * key to the control plane for the waiting device. Resolves with the bot's
 * final slug plus the mint to keep for retries. The three writes are not
 * one transaction, so: a slug collision retries once with a random suffix;
 * `provisioned` from an earlier attempt in the same workspace is reused rather
 * than minted again (re-asserting `readsAsOwner` only when it changed); and
 * when the control plane says the code is gone (404/409) the bot and key are
 * revoked so nothing usable is left behind.
 */
export async function approveConnect(input: ApproveConnectInput): Promise<{
  slug: string
  provisioned: ProvisionedBot
}> {
  let provisioned = input.provisioned?.workspaceId === input.workspace.id ? input.provisioned : undefined
  if (input.provisioned && !provisioned) {
    // The user picked another workspace after a failed attempt: the bot minted
    // in the first one would otherwise stay behind with a live key.
    await botsApi.archive(input.provisioned.workspaceId, input.provisioned.botId).catch(() => undefined)
  }
  const readsAsOwner = input.readsAsOwner ?? false
  if (provisioned && provisioned.readsAsOwner !== readsAsOwner) {
    // A retry reuses the minted bot, so a changed checkbox is re-asserted —
    // but only when it actually changed: an unconditional PATCH would make
    // every ordinary retry depend on one more write that can fail (the reason
    // this whole function tolerates retries at all).
    await botsApi.update(provisioned.workspaceId, provisioned.botId, { readsAsOwner })
    provisioned = { ...provisioned, readsAsOwner }
    input.onProvisioned?.(provisioned)
  }
  if (!provisioned) {
    const baseSlug = slugForBot(input.botName) || "bot"
    const create = (slug: string) =>
      botsApi.create(input.workspace.id, {
        type: "personal",
        name: input.botName,
        slug,
        traits: [BotTraits.MENTIONABLE, BotTraits.ACTIVE_SCRATCHPAD],
        ...(readsAsOwner ? { readsAsOwner: true } : {}),
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
    provisioned = {
      workspaceId: input.workspace.id,
      botId: bot.id,
      botSlug: bot.slug ?? baseSlug,
      keyId: key.key.id,
      apiKey: key.value,
      readsAsOwner,
    }
    input.onProvisioned?.(provisioned)
  }
  try {
    await botConnectApi.approve({
      code: input.code,
      workspaceId: provisioned.workspaceId,
      workspaceName: input.workspace.name,
      botId: provisioned.botId,
      botSlug: provisioned.botSlug,
      scope: CONNECTED_BOT_SCOPES.join(" "),
      apiKey: provisioned.apiKey,
    })
  } catch (error) {
    if (!(ApiError.isApiError(error) && (error.status === 404 || error.status === 409))) throw error
    // Archiving revokes every key of the bot in one transaction, so it is the
    // cleanup; a failure keeps the identifiers for another try.
    try {
      await botsApi.archive(provisioned.workspaceId, provisioned.botId)
    } catch {
      throw new ConnectCleanupFailedError(provisioned.botSlug)
    }
    throw new ConnectCodeGoneError()
  }
  return { slug: provisioned.botSlug, provisioned }
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
  const [readsAsOwner, setReadsAsOwner] = useState(false)
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const provisioned = useRef<ProvisionedBot | undefined>(undefined)
  const approve = useMutation({
    mutationFn: async () => {
      try {
        return await approveConnect({
          code,
          workspace: workspace!,
          botName: botName.trim(),
          readsAsOwner,
          provisioned: provisioned.current,
          onProvisioned: (next) => (provisioned.current = next),
        })
      } catch (error) {
        if (error instanceof ConnectCodeGoneError) provisioned.current = undefined
        throw error
      }
    },
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
        <div className="flex items-start gap-2.5 rounded-md border px-3 py-2.5">
          <Checkbox
            id="connect-reads-as-owner"
            checked={readsAsOwner}
            onCheckedChange={(checked) => setReadsAsOwner(checked === true)}
            disabled={busy}
            className="mt-0.5"
          />
          <div className="space-y-0.5">
            <Label htmlFor="connect-reads-as-owner" className="text-sm font-normal">
              Let it read everything you can read
            </Label>
            <p className="text-xs text-muted-foreground">
              Except end-to-end encrypted streams. It can still only post where it has been added. You can change this
              later in bot settings.
            </p>
          </div>
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
  const [params] = useSearchParams()
  const { user, loading: authLoading, login } = useAuth()
  const code = normalizeCode(params.get("code") ?? "")

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

  return <SignedInConnect />
}

/** Mounted only with a session: the workspace list query would otherwise 401 and bounce to login. */
function SignedInConnect() {
  const [params, setParams] = useSearchParams()
  const { workspaces, isLoading: workspacesLoading } = useWorkspaces()
  const code = normalizeCode(params.get("code") ?? "")
  const [done, setDone] = useState<{ slug: string; workspaceName: string } | "denied" | null>(null)

  const lookup = useQuery({
    queryKey: ["bot-connect-lookup", code],
    queryFn: () => botConnectApi.lookup(code),
    enabled: code.length === 9,
    retry: false,
  })

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
