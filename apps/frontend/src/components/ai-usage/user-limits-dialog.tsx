import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { AIUserLimits } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useResetAIUserLimits, useSetAIUserLimits } from "@/hooks"

interface UserLimitsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  userId: string
  userName: string
  /** Null when the user has no limits of their own. */
  limits: AIUserLimits | null
}

const toDraft = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value))

/** Empty means "no limit" (null); anything else must be a non-negative number, or undefined for invalid. */
function parseMoney(draft: string): number | null | undefined {
  const trimmed = draft.trim()
  if (trimmed === "") return null
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export function UserLimitsDialog({ open, onOpenChange, workspaceId, userId, userName, limits }: UserLimitsDialogProps) {
  const setLimits = useSetAIUserLimits(workspaceId)
  const resetLimits = useResetAIUserLimits(workspaceId)
  const [quota, setQuota] = useState("")
  const [allowance, setAllowance] = useState("")
  const [aiDisabled, setAiDisabled] = useState(false)

  useEffect(() => {
    if (open) {
      setQuota(toDraft(limits?.monthlyQuotaUsd))
      setAllowance(toDraft(limits?.agentAllowanceUsd))
      setAiDisabled(limits?.aiDisabled ?? false)
    }
  }, [open, limits?.monthlyQuotaUsd, limits?.agentAllowanceUsd, limits?.aiDisabled])

  const monthlyQuotaUsd = parseMoney(quota)
  const agentAllowanceUsd = parseMoney(allowance)
  const pending = setLimits.isPending || resetLimits.isPending
  const canSave = monthlyQuotaUsd !== undefined && agentAllowanceUsd !== undefined && !pending

  const handleSave = () => {
    if (monthlyQuotaUsd === undefined || agentAllowanceUsd === undefined || pending) return
    setLimits.mutate(
      { userId, input: { monthlyQuotaUsd, agentAllowanceUsd, aiDisabled } },
      {
        onSuccess: () => onOpenChange(false),
        onError: () => toast.error("Could not save AI limits"),
      }
    )
  }

  const handleReset = () => {
    if (pending) return
    resetLimits.mutate(userId, {
      onSuccess: () => onOpenChange(false),
      onError: () => toast.error("Could not reset AI limits"),
    })
  }

  return (
    // Text inputs: a content-height drawer rides above the phone keyboard.
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="max-w-[420px] gap-0 p-0 overflow-hidden"
        drawerClassName="flex max-h-[92dvh] flex-col gap-0 p-0 overflow-hidden"
      >
        <div className="px-4 pb-4 pt-4 sm:px-6 sm:pt-6">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle className="text-base">AI limits for {userName}</ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="text-xs">
              Monthly amounts. Leave a field empty for no personal limit.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
        </div>

        <div className="border-t border-border" />

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <div className="space-y-2">
            <Label htmlFor="user-limit-quota" className="text-sm font-medium">
              Total AI max
            </Label>
            <Input
              id="user-limit-quota"
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              placeholder="No limit"
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-limit-allowance" className="text-sm font-medium">
              Agent allowance
            </Label>
            <Input
              id="user-limit-allowance"
              type="number"
              min="0"
              step="1"
              inputMode="decimal"
              placeholder="Workspace default"
              value={allowance}
              onChange={(e) => setAllowance(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 p-3">
            <Label htmlFor="user-limit-disabled" className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">Turn off AI</span>
              <span className="text-xs font-normal text-muted-foreground">
                {aiDisabled ? `All AI is stopped for ${userName}.` : "Stops every AI feature for this person."}
              </span>
            </Label>
            <Switch id="user-limit-disabled" checked={aiDisabled} onCheckedChange={setAiDisabled} />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-muted/30 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 sm:px-6">
          {limits && (
            <Button variant="ghost" size="sm" onClick={handleReset} disabled={pending}>
              {resetLimits.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Reset to defaults
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave} className="min-w-20">
              {setLimits.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
