import { useEffect, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Check, Copy, Link as LinkIcon } from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { invitationsApi } from "@/api/invitations"
import { WORKSPACE_ROLE_SLUGS } from "@threa/types"
import {
  defaultInviteExpiry,
  InviteLinkSettingsFields,
  localDateTimeToIso,
  validateInviteLinkSettings,
  type InviteLinkSettingsValue,
} from "./invite-link-settings-fields"

interface CreateInviteLinkDialogProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  onTokenCreated?: (invitationId: string, token: string) => void
}

function buildJoinUrl(token: string): string {
  if (typeof window === "undefined") return `/join/${token}`
  return `${window.location.origin}/join/${token}`
}

function errorMessage(error: unknown): string | null {
  if (!error) return null
  if (error instanceof Error) return error.message
  return "Failed to create link."
}

function initialSettings(): InviteLinkSettingsValue {
  return { unlimited: false, maxUses: "1", neverExpires: false, expiresAt: defaultInviteExpiry() }
}

export function CreateInviteLinkDialog({
  workspaceId,
  open,
  onOpenChange,
  onSuccess,
  onTokenCreated,
}: CreateInviteLinkDialogProps) {
  const [note, setNote] = useState("")
  const [settings, setSettings] = useState<InviteLinkSettingsValue>(initialSettings)
  const [validationError, setValidationError] = useState<string | null>(null)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const createMutation = useMutation({
    mutationFn: () =>
      invitationsApi.createLink(workspaceId, {
        role: WORKSPACE_ROLE_SLUGS.MEMBER,
        note: note.trim() || undefined,
        maxUses: settings.unlimited ? null : Number(settings.maxUses),
        expiresAt: settings.neverExpires ? null : localDateTimeToIso(settings.expiresAt),
      }),
  })

  useEffect(() => {
    if (open) return
    generationRef.current += 1
    setNote("")
    setSettings(initialSettings())
    setValidationError(null)
    setCreatedToken(null)
    setCopied(false)
    setCopyError(null)
    createMutation.reset()
  }, [open])

  const close = () => onOpenChange(false)

  const submit = () => {
    const error = validateInviteLinkSettings(settings)
    setValidationError(error)
    if (error) return
    const generation = generationRef.current
    createMutation.mutate(undefined, {
      onSuccess: (data) => {
        if (generation !== generationRef.current) return
        setCreatedToken(data.token)
        onTokenCreated?.(data.invitation.id, data.token)
        onSuccess()
      },
    })
  }

  const copy = async () => {
    if (!createdToken) return
    try {
      await navigator.clipboard.writeText(buildJoinUrl(createdToken))
      setCopyError(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError("Could not copy the link. Select it and copy it manually.")
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()} disableSnapPoints>
      <ResponsiveDialogContent desktopClassName="max-w-md" drawerClassName="max-h-[92dvh] overflow-y-auto">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{createdToken ? "Invite link ready" : "Create invite link"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        {createdToken ? (
          <div className="space-y-5 px-4 sm:px-6">
            <div className="flex items-center gap-2 rounded-md border px-3 py-2">
              <input
                readOnly
                value={buildJoinUrl(createdToken)}
                onFocus={(event) => event.currentTarget.select()}
                aria-label="Share link"
                className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={copy}
                aria-label={copied ? "Copied" : "Copy link"}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            {copyError && (
              <p role="alert" className="text-sm text-destructive">
                {copyError}
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Copy this link now. It cannot be shown again after you close this dialog.
            </p>
            <ResponsiveDialogFooter>
              <Button onClick={close}>Done</Button>
            </ResponsiveDialogFooter>
          </div>
        ) : (
          <div className="space-y-5 px-4 sm:px-6">
            <InviteLinkSettingsFields value={settings} onChange={setSettings} />
            <div className="space-y-2">
              <Label htmlFor="link-note">
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input id="link-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} />
            </div>
            {(validationError || createMutation.error) && (
              <p role="alert" className="text-sm text-destructive">
                {validationError ?? errorMessage(createMutation.error)}
              </p>
            )}
            <ResponsiveDialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={createMutation.isPending}>
                <LinkIcon className="mr-2 h-4 w-4" />
                {createMutation.isPending ? "Creating..." : "Create link"}
              </Button>
            </ResponsiveDialogFooter>
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
