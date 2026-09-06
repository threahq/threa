import { toast } from "sonner"
import { useParams } from "react-router-dom"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { usePreferences } from "@/contexts"
import { useWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { ApiError } from "@/api/client"

export function PrivacySettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference } = usePreferences()
  const { data: bootstrap } = useWorkspaceBootstrap(workspaceId ?? "")
  const configured = Boolean(bootstrap?.analytics)
  const granted = configured && preferences?.analyticsConsent === "granted"

  async function toggle(checked: boolean) {
    try {
      await updatePreference("analyticsConsent", checked ? "granted" : "denied")
    } catch (err) {
      toast.error(ApiError.isApiError(err) ? err.message : "Failed to update the privacy preference")
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="analytics-consent">Send crash reports and usage data</Label>
            <p className="text-sm text-muted-foreground">
              {configured
                ? "Helps us find and fix bugs. Message content is never included."
                : "Not configured for this workspace."}
            </p>
          </div>
          <Switch
            className="shrink-0"
            id="analytics-consent"
            checked={granted}
            disabled={!configured}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </div>
      </section>
    </div>
  )
}
