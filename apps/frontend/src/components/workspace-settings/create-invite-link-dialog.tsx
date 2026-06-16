import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Check, Copy, KeyRound, Link as LinkIcon, ShieldCheck } from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { invitationsApi } from "@/api/invitations"
import { WORKSPACE_ROLE_SLUGS, type WorkspaceInvitableRole } from "@threa/types"

function resolveErrorMessage(isError: boolean, err: unknown): string | null {
  if (!isError) return null
  if (err instanceof Error) return err.message
  return "Failed to create link."
}

interface CreateInviteLinkDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  /** Receives the plaintext token immediately after creation. Token is never retrievable later. */
  onTokenCreated?: (invitationId: string, token: string) => void
}

/**
 * Build the share URL from the current origin so the link reads naturally
 * on whatever frontend the admin is using (staging, PR preview, prod) without
 * the backend having to know about it.
 */
function buildJoinUrl(token: string): string {
  if (typeof window === "undefined") return `/join/${token}`
  return `${window.location.origin}/join/${token}`
}

export function CreateInviteLinkDialog({
  workspaceId,
  open,
  onOpenChange,
  onSuccess,
  onTokenCreated,
}: CreateInviteLinkDialogProps) {
  const [role, setRole] = useState<WorkspaceInvitableRole>(WORKSPACE_ROLE_SLUGS.MEMBER)
  const [note, setNote] = useState("")
  const [copied, setCopied] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: () =>
      invitationsApi.createLink(workspaceId, {
        role,
        note: note.trim() || undefined,
      }),
    onSuccess: (data) => {
      setCreatedToken(data.token)
      onTokenCreated?.(data.invitation.id, data.token)
      onSuccess()
    },
  })

  const handleClose = () => {
    setRole(WORKSPACE_ROLE_SLUGS.MEMBER)
    setNote("")
    setCopied(false)
    setCreatedToken(null)
    onOpenChange(false)
  }

  const handleCopy = async () => {
    if (!createdToken) return
    try {
      await navigator.clipboard.writeText(buildJoinUrl(createdToken))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can fail in insecure contexts — ignore silently.
    }
  }

  const joinUrl = createdToken ? buildJoinUrl(createdToken) : ""

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <ResponsiveDialogContent desktopClassName="max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{createdToken ? "Invite link ready" : "Create invite link"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        {createdToken ? (
          <TokenReadyView joinUrl={joinUrl} copied={copied} onCopy={handleCopy} onDone={handleClose} />
        ) : (
          <CreateFormView
            role={role}
            onRoleChange={setRole}
            note={note}
            onNoteChange={setNote}
            isSubmitting={createMutation.isPending}
            errorMessage={resolveErrorMessage(createMutation.isError, createMutation.error)}
            onCancel={handleClose}
            onSubmit={() => createMutation.mutate()}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function TokenReadyView({
  joinUrl,
  copied,
  onCopy,
  onDone,
}: {
  joinUrl: string
  copied: boolean
  onCopy: () => void
  onDone: () => void
}) {
  return (
    <div className="space-y-6 px-4 sm:px-6">
      {/* The plaintext token only exists right now — this view is gone once the dialog closes. */}
      <div className="flex flex-col items-center gap-3 pt-1">
        <div className="relative flex h-14 w-14 items-center justify-center">
          <div aria-hidden className="absolute inset-0 rounded-full bg-primary/20 blur-xl" />
          <div className="relative flex h-12 w-12 items-center justify-center rounded-full border bg-background">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
        </div>
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Reveal once</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-primary/30 bg-gradient-to-b from-primary/5 to-transparent">
        <div className="flex items-center gap-2 px-3 py-2">
          <LinkIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <input
            readOnly
            value={joinUrl}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Share link"
            className="flex-1 bg-transparent font-mono text-xs text-foreground outline-none selection:bg-primary/20"
          />
          <Button
            type="button"
            size="sm"
            variant={copied ? "default" : "outline"}
            onClick={onCopy}
            aria-label={copied ? "Copied" : "Copy link"}
            className="h-7 gap-1 px-2.5 text-[11px] font-medium uppercase tracking-[0.10em] transition-colors"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Share it through any channel. The recipient enters their email when they open it — single use, expires in 7
        days.
      </p>

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2.5">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          We only stored the link's hash. Copy it now — once this dialog closes you won't see it again.
        </p>
      </div>

      <ResponsiveDialogFooter>
        <Button onClick={onDone} className="w-full sm:w-auto">
          Done
        </Button>
      </ResponsiveDialogFooter>
    </div>
  )
}

function CreateFormView({
  role,
  onRoleChange,
  note,
  onNoteChange,
  isSubmitting,
  errorMessage,
  onCancel,
  onSubmit,
}: {
  role: WorkspaceInvitableRole
  onRoleChange: (role: WorkspaceInvitableRole) => void
  note: string
  onNoteChange: (note: string) => void
  isSubmitting: boolean
  errorMessage: string | null
  onCancel: () => void
  onSubmit: () => void
}) {
  return (
    <div className="space-y-5 px-4 sm:px-6">
      <p className="text-sm text-muted-foreground">
        Generate a single-use link and share it however you want. The recipient enters their email when they open it.
      </p>

      <div className="space-y-2">
        <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground font-medium">Role</Label>
        <ToggleGroup
          type="single"
          value={role}
          onValueChange={(v) => v && onRoleChange(v as WorkspaceInvitableRole)}
          variant="outline"
          className="w-full"
        >
          <ToggleGroupItem value={WORKSPACE_ROLE_SLUGS.MEMBER} className="flex-1">
            Member
          </ToggleGroupItem>
          <ToggleGroupItem value={WORKSPACE_ROLE_SLUGS.ADMIN} className="flex-1">
            Admin
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="space-y-2">
        <Label
          htmlFor="link-note"
          className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground font-medium"
        >
          Note <span className="normal-case tracking-normal text-muted-foreground/70">(optional)</span>
        </Label>
        <Input
          id="link-note"
          placeholder="e.g. shared in #design — sent via Signal"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          maxLength={200}
        />
        <p className="text-xs text-muted-foreground">
          Only visible to admins. Helps you remember what each link is for.
        </p>
      </div>

      {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}

      <ResponsiveDialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={isSubmitting}>
          {isSubmitting ? (
            "Creating…"
          ) : (
            <>
              <LinkIcon className="mr-2 h-4 w-4" />
              Create link
            </>
          )}
        </Button>
      </ResponsiveDialogFooter>
    </div>
  )
}
